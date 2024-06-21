from PIL import Image
import random
import sys
import os


def get_random_color_for_mode(mode):
    if mode == 'RGB':
        return (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
    elif mode == 'L':  # 黑白图片，只需一个值
        return random.randint(0, 255)
    else:
        raise ValueError(f"Unsupported image mode: {mode}")
    

def add_random_pixels(image_path):
    image = Image.open(image_path)
    pixels = image.load()

    width, height = image.size
    random_pixel_count = random.randint(10, 60)
    
    for _ in range(random_pixel_count):
        x = random.randint(0, width - 1)
        y = random.randint(0, height - 1)
        color = get_random_color_for_mode(image.mode)
        pixels[x, y] = color

    output_path = image_path.replace('.jpg', '_modified.jpg')

    if image.mode == 'RGBA':
        image = image.convert('RGB')
    
    image.save(output_path)
    return output_path

if __name__ == '__main__':
    input_image_path = sys.argv[1]
    output_image_path = add_random_pixels(input_image_path)
    print(output_image_path)
