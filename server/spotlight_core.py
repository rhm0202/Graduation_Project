import asyncio
import json
import math
import time
import websockets
from modules.logger import get_logger
from modules.pid_controller import MotorPIDManager
from modules.config import (
    RPI_WS_URL, WS_PORT, FRAME_WIDTH, FRAME_HEIGHT,
    PID_KP, PID_KI, PID_KD, PID_OUTPUT_LIMIT, EMA_ALPHA,
    X_DEAD_ZONE, Y_DEAD_ZONE, MAX_JUMP_PX, MIN_SEND_INTERVAL,
    COMMAND_TTL_MS, MOTOR_STATUS_TIMEOUT,
)

logger = get_logger("spotlight_core")
pid_manager = None
tracking_state = "off"
_desktop = None
_desktop_epoch = -1
_pi_connected = False
_pi_ready = False
_motor_status = None
_session_id = None
_control_epoch = 0
_sequence = 0
_remote_time_ms = None
_last_status_time = 0.0
_last_send_time = 0.0
_prev_obj_x = None
_prev_obj_y = None
_pending_control = None
_pending_motion = None
_send_event = None


def reset_observations():
    global _last_send_time, _prev_obj_x, _prev_obj_y
    _last_send_time = 0.0
    _prev_obj_x = _prev_obj_y = None
    pid_manager.reset()


def request_sync(*, center=False):
    """A new epoch invalidates all previous observations and queued movement."""
    global _control_epoch, _pi_ready, _pending_control, _pending_motion
    _control_epoch += 1
    _pi_ready = False
    _pending_motion = None
    reset_observations()
    _pending_control = {
        "type": "control_state", "epoch": _control_epoch,
        "tracking": tracking_state, "center": center and _pi_connected,
        "created": time.monotonic(),
    }
    _send_event.set()


async def publish_status():
    if _desktop is None:
        return
    status = {
        "type": "control_status", "connected": _pi_connected,
        "ready": _pi_ready, "motor": _motor_status,
        "error": (_motor_status or {}).get("fault"),
    }
    try:
        await asyncio.wait_for(_desktop.send(json.dumps(status)), timeout=0.2)
    except (TimeoutError, websockets.exceptions.ConnectionClosed):
        pass


async def send_to_pi(data):
    """Keep one latest motion, never a backlog to replay after reconnect."""
    global _pending_motion
    if not _pi_connected or not _pi_ready:
        return False
    _pending_motion = {**data, "epoch": _control_epoch, "created": time.monotonic()}
    _send_event.set()
    return True


async def process_object_detected(obj_x, obj_y, observed_at_ms):
    global _last_send_time, _prev_obj_x, _prev_obj_y, _pending_motion
    if tracking_state != "on" or not _pi_ready:
        return
    if not all(math.isfinite(v) for v in (obj_x, obj_y, observed_at_ms)):
        return
    if not (0 <= obj_x <= FRAME_WIDTH and 0 <= obj_y <= FRAME_HEIGHT):
        return
    # Renderer and core run on the same PC. Pi expiry uses its own monotonic clock.
    age_ms = time.time() * 1000 - observed_at_ms
    now = time.monotonic()
    if not 0 <= age_ms <= COMMAND_TTL_MS or now - _last_status_time > MOTOR_STATUS_TIMEOUT:
        return
    if now - _last_send_time < MIN_SEND_INTERVAL:
        return
    if _prev_obj_x is not None and (abs(obj_x - _prev_obj_x) > MAX_JUMP_PX
                                    or abs(obj_y - _prev_obj_y) > MAX_JUMP_PX):
        _pending_motion = None
        pid_manager.reset()
        _prev_obj_x, _prev_obj_y = obj_x, obj_y
        return
    _prev_obj_x, _prev_obj_y = obj_x, obj_y
    _last_send_time = now
    pan, tilt = pid_manager.update(obj_x, obj_y)
    await send_to_pi({
        "type": "servo_angle", "pan_angle": round(pan, 2), "tilt_angle": round(tilt, 2),
        # Conservatively use the last received Pi timestamp, without assuming synchronized clocks.
        "expires_at_ms": _remote_time_ms + COMMAND_TTL_MS - age_ms,
    })


async def pi_sender_task(websocket):
    global _pending_control, _pending_motion, _sequence
    while True:
        await _send_event.wait()
        _send_event.clear()
        if _session_id is None or _remote_time_ms is None:
            continue
        if _pending_control is not None:
            data, _pending_control = _pending_control, None
            data = dict(data)
            age = (time.monotonic() - data.pop("created")) * 1000
            # A delayed center button is never replayed after an outage.
            data["center"] = data["center"] and age <= COMMAND_TTL_MS
            data["expires_at_ms"] = _remote_time_ms + COMMAND_TTL_MS
        elif _pending_motion is not None:
            data, _pending_motion = _pending_motion, None
            if not _pi_ready or data["epoch"] != _control_epoch:
                continue
            if (time.monotonic() - data.pop("created")) * 1000 > COMMAND_TTL_MS:
                continue
        else:
            continue
        if time.monotonic() - _last_status_time > MOTOR_STATUS_TIMEOUT:
            raise ConnectionError("Pi motor status timed out")
        _sequence += 1
        data.update(session_id=_session_id, seq=_sequence)
        # A blocked send must terminate this connection, not consume more commands.
        await asyncio.wait_for(websocket.send(json.dumps(data)), timeout=COMMAND_TTL_MS / 1000)


async def pi_receiver_task(websocket):
    global _session_id, _remote_time_ms, _last_status_time, _motor_status, _pi_ready
    while True:
        message = await asyncio.wait_for(websocket.recv(), timeout=MOTOR_STATUS_TIMEOUT)
        data = json.loads(message)
        if not isinstance(data, dict) or data.get("type") != "motor_status":
            continue
        if data.get("protocol") != 2:
            raise ValueError("Pi control protocol update required")
        session = data["session_id"]
        if _session_id is not None and session != _session_id:
            raise ValueError("Pi session changed")
        remote_time = float(data["device_time_ms"])
        pan, tilt = float(data["pan"]["angle"]), float(data["tilt"]["angle"])
        if not all(math.isfinite(v) for v in (remote_time, pan, tilt)):
            raise ValueError("Invalid motor status")
        _session_id = session
        _remote_time_ms = remote_time
        _last_status_time = time.monotonic()
        _motor_status = data
        healthy = data["pan"]["healthy"] and data["tilt"]["healthy"] and not data.get("fault")
        synchronized = data.get("epoch") == _control_epoch and data.get("tracking") == tracking_state
        if healthy and synchronized:
            if not _pi_ready:
                reset_observations()
            pid_manager.sync_angles(pan, tilt)
            _pi_ready = True
        else:
            _pi_ready = False
        _send_event.set()
        await publish_status()


async def connect_to_pi():
    global _pi_connected, _pi_ready, _session_id, _remote_time_ms, _motor_status
    global _pending_control, _pending_motion, _sequence
    while True:
        try:
            logger.info(f"RPi 연결 시도: {RPI_WS_URL}")
            async with websockets.connect(RPI_WS_URL, ping_interval=10, ping_timeout=5, close_timeout=1, max_queue=1) as websocket:
                _pi_connected = True
                _session_id = _remote_time_ms = None
                _sequence = 0
                request_sync()
                sender = asyncio.create_task(pi_sender_task(websocket))
                receiver = asyncio.create_task(pi_receiver_task(websocket))
                try:
                    done, _ = await asyncio.wait((sender, receiver), return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    sender.cancel()
                    receiver.cancel()
                    await asyncio.gather(sender, receiver, return_exceptions=True)
        except Exception as error:
            logger.warning(f"RPi 연결 종료: {error}")
        finally:
            _pi_connected = _pi_ready = False
            _session_id = _remote_time_ms = _motor_status = None
            _pending_control = _pending_motion = None
            reset_observations()
            await publish_status()
        await asyncio.sleep(3)


async def ws_handler(websocket):
    global _desktop, _desktop_epoch, tracking_state
    previous = _desktop
    _desktop = websocket
    _desktop_epoch = -1
    tracking_state = "off"
    request_sync()
    if previous is not None:
        await previous.close(1001, "New desktop connection")
    await publish_status()
    try:
        async for message in websocket:
            if _desktop is not websocket:
                break
            try:
                data = json.loads(message)
                if not isinstance(data, dict):
                    continue
                if "tracking" in data:
                    epoch = data.get("epoch")
                    if data["tracking"] not in ("on", "off") or type(epoch) is not int or epoch <= _desktop_epoch:
                        continue
                    _desktop_epoch = epoch
                    tracking_state = data["tracking"]
                    request_sync()
                elif data.get("type") == "servo_init":
                    tracking_state = "off"
                    request_sync(center=True)
                elif data.get("type") == "object_detected" and data.get("epoch") == _desktop_epoch:
                    await process_object_detected(float(data["obj_x"]), float(data["obj_y"]), float(data["observed_at_ms"]))
            except (ValueError, TypeError, KeyError):
                continue
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if _desktop is websocket:
            _desktop = None
            tracking_state = "off"
            request_sync()


async def main():
    global pid_manager, _send_event
    _send_event = asyncio.Event()
    pid_manager = MotorPIDManager(
        frame_width=FRAME_WIDTH, frame_height=FRAME_HEIGHT,
        pid_kp=PID_KP, pid_ki=PID_KI, pid_kd=PID_KD,
        output_limit=PID_OUTPUT_LIMIT, ema_alpha=EMA_ALPHA,
        x_dead_zone=X_DEAD_ZONE, y_dead_zone=Y_DEAD_ZONE,
    )
    async with websockets.serve(ws_handler, "127.0.0.1", WS_PORT, close_timeout=1, max_queue=1):
        await connect_to_pi()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("서버 종료")
