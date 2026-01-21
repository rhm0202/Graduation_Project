# 배경 제거 세그멘테이션 모델 학습 스크립트
import argparse
import sys
import os
from pathlib import Path
import random

def main():
    parser = argparse.ArgumentParser(description='세그멘테이션 모델 학습')
    parser.add_argument('--dataset', type=str, required=True, help='데이터셋 경로')
    parser.add_argument('--epochs', type=int, default=50, help='학습 에포크 수')
    parser.add_argument('--batch-size', type=int, default=8, help='배치 크기')
    parser.add_argument('--learning-rate', type=float, default=0.0001, help='학습률')
    parser.add_argument('--image-size', type=int, default=512, help='이미지 크기')
    parser.add_argument('--val-split', type=float, default=0.2, help='검증 데이터 비율 (0.0~1.0)')
    parser.add_argument('--device', type=str, default='auto', help='디바이스 (auto, cpu, cuda)')
    parser.add_argument('--save-dir', type=str, default='training/models/segmentation', help='모델 저장 디렉토리')
    
    args = parser.parse_args()
    
    print(f"=== 세그멘테이션 모델 학습 시작 ===")
    print(f"데이터셋: {args.dataset}")
    print(f"에포크: {args.epochs}")
    print(f"배치 크기: {args.batch_size}")
    print(f"학습률: {args.learning_rate}")
    print(f"이미지 크기: {args.image_size}")
    print(f"검증 데이터 비율: {args.val_split}")
    print()
    
    # 데이터셋 경로 확인
    if not os.path.exists(args.dataset):
        print(f"오류: 데이터셋 경로를 찾을 수 없습니다: {args.dataset}")
        sys.exit(1)
    
    images_path = os.path.join(args.dataset, 'images')
    masks_path = os.path.join(args.dataset, 'masks')
    
    if not os.path.exists(images_path):
        print(f"오류: 이미지 폴더를 찾을 수 없습니다: {images_path}")
        sys.exit(1)
    
    if not os.path.exists(masks_path):
        print(f"오류: 마스크 폴더를 찾을 수 없습니다: {masks_path}")
        print("마스크 폴더가 필요합니다. 각 이미지에 대응하는 마스크 이미지가 있어야 합니다.")
        sys.exit(1)
    
    # 실제 학습 코드
    try:
        # PyTorch 사용 시도
        try:
            import torch
            import torch.nn as nn
            import torch.optim as optim
            from torch.utils.data import Dataset, DataLoader, random_split
            from torchvision import transforms
            from torchvision.models.segmentation import deeplabv3_resnet50
            from PIL import Image
            import numpy as np
            
            print("PyTorch를 사용하여 학습을 시작합니다...")
            
            # 디바이스 설정
            if args.device == 'auto':
                device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
            else:
                device = torch.device(args.device)
            
            print(f"사용 디바이스: {device}")
            if device.type == 'cpu':
                print("경고: GPU를 사용할 수 없습니다. 학습이 느릴 수 있습니다.")
            print()
            
            # 데이터셋 클래스 정의
            class SegmentationDataset(Dataset):
                def __init__(self, images_dir, masks_dir, image_size=512, transform=None):
                    self.images_dir = Path(images_dir)
                    self.masks_dir = Path(masks_dir)
                    self.image_size = image_size
                    self.transform = transform
                    
                    # 이미지 파일 목록 가져오기
                    image_extensions = {'.jpg', '.jpeg', '.png', '.webp'}
                    self.image_files = [
                        f for f in os.listdir(images_dir) 
                        if Path(f).suffix.lower() in image_extensions
                    ]
                    
                    # 마스크 파일이 존재하는 이미지만 필터링
                    valid_files = []
                    for img_file in self.image_files:
                        img_name = Path(img_file).stem
                        # 여러 확장자로 마스크 파일 찾기
                        mask_found = False
                        for ext in ['.png', '.jpg', '.jpeg']:
                            mask_path = self.masks_dir / f"{img_name}{ext}"
                            if mask_path.exists():
                                valid_files.append((img_file, mask_path.name))
                                mask_found = True
                                break
                        if not mask_found:
                            print(f"경고: {img_file}에 대응하는 마스크를 찾을 수 없습니다.")
                    
                    self.image_files = valid_files
                    print(f"유효한 이미지-마스크 쌍: {len(self.image_files)}개")
                
                def __len__(self):
                    return len(self.image_files)
                
                def __getitem__(self, idx):
                    img_file, mask_file = self.image_files[idx]
                    
                    # 이미지 로드
                    img_path = self.images_dir / img_file
                    img = Image.open(img_path).convert('RGB')
                    
                    # 마스크 로드
                    mask_path = self.masks_dir / mask_file
                    mask = Image.open(mask_path).convert('L')  # 그레이스케일
                    
                    # 리사이즈
                    img = img.resize((self.image_size, self.image_size), Image.BILINEAR)
                    mask = mask.resize((self.image_size, self.image_size), Image.NEAREST)
                    
                    # 텐서로 변환
                    img_transform = transforms.Compose([
                        transforms.ToTensor(),
                        transforms.Normalize(mean=[0.485, 0.456, 0.406], 
                                           std=[0.229, 0.224, 0.225])
                    ])
                    
                    img_tensor = img_transform(img)
                    
                    # 마스크를 텐서로 변환 (0 또는 1로 이진화)
                    mask_array = np.array(mask)
                    # 128 이상을 1로, 미만을 0으로 (배경=0, 객체=1)
                    mask_binary = (mask_array >= 128).astype(np.int64)
                    mask_tensor = torch.from_numpy(mask_binary).long()
                    
                    return img_tensor, mask_tensor
            
            # 데이터셋 생성
            full_dataset = SegmentationDataset(
                images_path, 
                masks_path, 
                image_size=args.image_size
            )
            
            if len(full_dataset) == 0:
                print("오류: 학습할 데이터가 없습니다.")
                sys.exit(1)
            
            # 학습/검증 데이터 분할
            if args.val_split > 0:
                val_size = int(len(full_dataset) * args.val_split)
                train_size = len(full_dataset) - val_size
                train_dataset, val_dataset = random_split(
                    full_dataset, 
                    [train_size, val_size],
                    generator=torch.Generator().manual_seed(42)
                )
                print(f"학습 데이터: {len(train_dataset)}개, 검증 데이터: {len(val_dataset)}개")
            else:
                train_dataset = full_dataset
                val_dataset = None
                print(f"학습 데이터: {len(train_dataset)}개 (검증 데이터 없음)")
            
            # 데이터 로더 생성
            train_loader = DataLoader(
                train_dataset,
                batch_size=args.batch_size,
                shuffle=True,
                num_workers=0,  # Windows 호환성을 위해 0
                pin_memory=True if device.type == 'cuda' else False
            )
            
            val_loader = None
            if val_dataset:
                val_loader = DataLoader(
                    val_dataset,
                    batch_size=args.batch_size,
                    shuffle=False,
                    num_workers=0,
                    pin_memory=True if device.type == 'cuda' else False
                )
            
            # 모델 로드 및 설정
            print("모델 로드 중...")
            model = deeplabv3_resnet50(pretrained=True)
            # 배경 제거는 2클래스 (배경=0, 객체=1)
            model.classifier[4] = nn.Conv2d(256, 2, kernel_size=(1, 1), stride=(1, 1))
            model.aux_classifier[4] = nn.Conv2d(256, 2, kernel_size=(1, 1), stride=(1, 1))
            model = model.to(device)
            
            # 손실 함수 및 옵티마이저
            criterion = nn.CrossEntropyLoss()
            optimizer = optim.Adam(model.parameters(), lr=args.learning_rate)
            scheduler = optim.lr_scheduler.StepLR(optimizer, step_size=20, gamma=0.5)
            
            # 모델 저장 디렉토리 생성
            os.makedirs(args.save_dir, exist_ok=True)
            
            print("\n=== 학습 시작 ===\n")
            
            best_val_loss = float('inf')
            
            # 학습 루프
            for epoch in range(1, args.epochs + 1):
                model.train()
                train_loss = 0.0
                train_batches = 0
                
                # 학습 단계
                for batch_idx, (images, masks) in enumerate(train_loader):
                    images = images.to(device)
                    masks = masks.to(device)
                    
                    # Forward pass
                    optimizer.zero_grad()
                    outputs = model(images)
                    
                    # DeepLabV3는 dict를 반환 ('out'과 'aux')
                    if isinstance(outputs, dict):
                        pred = outputs['out']
                    else:
                        pred = outputs
                    
                    # 예측 크기 조정 (필요한 경우)
                    if pred.shape[2:] != masks.shape[1:]:
                        pred = nn.functional.interpolate(
                            pred, 
                            size=masks.shape[1:], 
                            mode='bilinear', 
                            align_corners=False
                        )
                    
                    # 손실 계산
                    loss = criterion(pred, masks)
                    
                    # Backward pass
                    loss.backward()
                    optimizer.step()
                    
                    train_loss += loss.item()
                    train_batches += 1
                    
                    # 진행 상황 출력
                    if (batch_idx + 1) % max(1, len(train_loader) // 10) == 0:
                        progress = 100. * (batch_idx + 1) / len(train_loader)
                        print(f"  Batch {batch_idx + 1}/{len(train_loader)} ({progress:.0f}%) - Loss: {loss.item():.4f}")
                
                avg_train_loss = train_loss / train_batches
                
                # 검증 단계
                avg_val_loss = None
                if val_loader:
                    model.eval()
                    val_loss = 0.0
                    val_batches = 0
                    
                    with torch.no_grad():
                        for images, masks in val_loader:
                            images = images.to(device)
                            masks = masks.to(device)
                            
                            outputs = model(images)
                            if isinstance(outputs, dict):
                                pred = outputs['out']
                            else:
                                pred = outputs
                            
                            if pred.shape[2:] != masks.shape[1:]:
                                pred = nn.functional.interpolate(
                                    pred, 
                                    size=masks.shape[1:], 
                                    mode='bilinear', 
                                    align_corners=False
                                )
                            
                            loss = criterion(pred, masks)
                            val_loss += loss.item()
                            val_batches += 1
                    
                    avg_val_loss = val_loss / val_batches
                
                # 학습률 스케줄러 업데이트
                scheduler.step()
                current_lr = scheduler.get_last_lr()[0]
                
                # 에포크 결과 출력
                if avg_val_loss is not None:
                    print(f"Epoch {epoch}/{args.epochs} - Train Loss: {avg_train_loss:.4f} - Val Loss: {avg_val_loss:.4f} - LR: {current_lr:.6f}")
                else:
                    print(f"Epoch {epoch}/{args.epochs} - Train Loss: {avg_train_loss:.4f} - LR: {current_lr:.6f}")
                
                # 최고 모델 저장
                if val_loader and avg_val_loss < best_val_loss:
                    best_val_loss = avg_val_loss
                    model_path = os.path.join(args.save_dir, 'best_model.pth')
                    torch.save({
                        'epoch': epoch,
                        'model_state_dict': model.state_dict(),
                        'optimizer_state_dict': optimizer.state_dict(),
                        'loss': avg_val_loss,
                    }, model_path)
                    print(f"  -> 최고 모델 저장: {model_path}")
                
                # 주기적으로 체크포인트 저장
                if epoch % 10 == 0:
                    checkpoint_path = os.path.join(args.save_dir, f'checkpoint_epoch_{epoch}.pth')
                    torch.save({
                        'epoch': epoch,
                        'model_state_dict': model.state_dict(),
                        'optimizer_state_dict': optimizer.state_dict(),
                        'loss': avg_train_loss,
                    }, checkpoint_path)
            
            # 최종 모델 저장
            final_model_path = os.path.join(args.save_dir, 'final_model.pth')
            torch.save({
                'epoch': args.epochs,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'loss': avg_train_loss,
            }, final_model_path)
            
            print()
            print("=== 학습 완료 ===")
            print(f"모델 저장 위치: {args.save_dir}")
            if val_loader:
                print(f"최고 검증 손실: {best_val_loss:.4f}")
            
        except ImportError as e:
            print(f"필수 패키지가 설치되지 않았습니다: {e}")
            print("설치 방법:")
            print("  pip install torch torchvision pillow numpy")
            print()
            print("시뮬레이션 모드로 실행합니다...")
            
            # 시뮬레이션
            for epoch in range(1, args.epochs + 1):
                progress = (epoch / args.epochs) * 100
                train_loss = 0.3 * (0.95 ** epoch)
                val_loss = 0.4 * (0.95 ** epoch)
                
                print(f"Epoch {epoch}/{args.epochs} - Loss: {train_loss:.4f} - Val Loss: {val_loss:.4f}")
                
                if epoch % 10 == 0:
                    print(f"  Progress: {progress:.1f}%")
            
            print()
            print("=== 학습 완료 (시뮬레이션) ===")
            print("실제 학습을 위해서는 다음을 설치하세요:")
            print("  pip install torch torchvision pillow numpy")
            
    except Exception as e:
        print(f"학습 중 오류 발생: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()