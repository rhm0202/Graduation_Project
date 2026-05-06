"""
logger.py
─────────
공통 로거 생성 모듈.

사용 예:
    from modules.logger import get_logger
    logger = get_logger("spotlight_core")
"""

import logging
import os
from logging.handlers import RotatingFileHandler

_LOG_DIR      = "logs"
_MAX_BYTES    = 1_000_000  # 1MB
_BACKUP_COUNT = 3
_FORMAT       = "[%(asctime)s] %(levelname)s - %(message)s"
_DATE_FORMAT  = "%Y-%m-%d %H:%M:%S"


def get_logger(name: str) -> logging.Logger:
    """name 기반 로거를 생성해 반환한다.

    - 파일: logs/<name>.log (1MB 초과 시 롤오버, 최대 3개 보관)
    - 콘솔: 동시 출력
    - 레벨: DEBUG

    Args:
        name: 로거 이름 (파일명으로도 사용됨)

    Returns:
        설정이 완료된 Logger 인스턴스
    """
    os.makedirs(_LOG_DIR, exist_ok=True)

    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    # 이미 핸들러가 등록된 경우 중복 추가 방지
    if logger.handlers:
        return logger

    formatter = logging.Formatter(_FORMAT, datefmt=_DATE_FORMAT)

    file_handler = RotatingFileHandler(
        f"{_LOG_DIR}/{name}.log",
        maxBytes=_MAX_BYTES,
        backupCount=_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.stream = open(
        console_handler.stream.fileno(), 'w', encoding='utf-8', closefd=False
    )
    console_handler.setFormatter(formatter)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger
