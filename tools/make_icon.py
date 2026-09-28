"""
用 vmrp 目录下的 icon.png 生成飞牛应用所需的各尺寸图标。
源图: ../vmrp/icon.png (192x192, 官方 MRP/冒泡 logo)

输出:
  ICON.PNG                 64x64
  ICON_256.PNG             256x256
  app/ui/images/icon_64.png   64x64
  app/ui/images/icon_256.png  256x256
"""
from PIL import Image
import os

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'vmrp', 'icon.png')

TARGETS = [
    ('ICON.PNG', 64),
    ('ICON_256.PNG', 256),
    ('app/ui/images/icon_64.png', 64),
    ('app/ui/images/icon_256.png', 256),
]


def main():
    src = Image.open(SRC).convert('RGBA')
    print('源图: {} {}'.format(SRC, src.size))

    # 源图为正方形, 直接等比缩放到目标尺寸 (LANCZOS 保质量)
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    for rel, size in TARGETS:
        # 若源图非方形, 先居中裁成方形再缩放
        w, h = src.size
        if w != h:
            side = min(w, h)
            left = (w - side) // 2
            top = (h - side) // 2
            img = src.crop((left, top, left + side, top + side))
        else:
            img = src

        out_img = img.resize((size, size), Image.LANCZOS)
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        out_img.save(p, 'PNG')
        print('生成', rel, out_img.size)


if __name__ == '__main__':
    main()
