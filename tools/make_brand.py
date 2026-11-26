import os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
SS = 4  # supersampling

def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(len(a)))

def gradient(size, c1, c2):
    w, h = size
    g = Image.new("RGBA", size)
    px = g.load()
    for y in range(h):
        for x in range(w):
            t = (x + y) / (w + h - 2)
            px[x, y] = lerp(c1, c2, t) + (255,)
    return g

def rounded_mask(size, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0]-1, size[1]-1], r, fill=255)
    return m

def card_layer(S, box, r, fill, angle, shadow=True):
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if shadow:
        sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([box[0], box[1]+S*0.02, box[2], box[3]+S*0.02], r, fill=(20, 10, 60, 90))
        sh = sh.filter(ImageFilter.GaussianBlur(S*0.025))
        layer = Image.alpha_composite(layer, sh)
        d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, r, fill=fill)
    return layer.rotate(angle, resample=Image.BICUBIC, center=(S/2, S/2))

C1, C2 = (99, 91, 255), (0, 194, 203)   # indigo -> teal

def icon(px):
    S = px * SS
    bg = gradient((S, S), C1, C2)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(bg, (0, 0), rounded_mask((S, S), int(S*0.225)))
    cw, ch = S*0.60, S*0.60/1.586
    cx, cy = S/2, S/2
    r = int(S*0.055)
    back = card_layer(S, [cx-cw/2, cy-ch/2-S*0.06, cx+cw/2, cy+ch/2-S*0.06], r, (255, 255, 255, 110), 14, shadow=False)
    out = Image.alpha_composite(out, back)
    fbox = [cx-cw/2, cy-ch/2+S*0.07, cx+cw/2, cy+ch/2+S*0.07]
    front = card_layer(S, fbox, r, (255, 255, 255, 255), -6)
    # barcode on the front card (drawn unrotated then rotated with it)
    bars = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bars)
    x0, x1 = fbox[0] + cw*0.14, fbox[2] - cw*0.14
    y0, y1 = fbox[1] + ch*0.30, fbox[3] - ch*0.22
    pattern = [2,1,1,3,1,2,2,1,3,1,1,2,1,3,2,1,1,2,3,1,2,1]
    unit = (x1-x0) / (sum(pattern))
    x = x0
    for i, w in enumerate(pattern):
        if i % 2 == 0:
            t = (x - x0) / (x1 - x0)
            bd.rectangle([x, y0, x + w*unit - 1, y1], fill=lerp(C1, C2, t) + (255,))
        x += w*unit
    bars = bars.rotate(-6, resample=Image.BICUBIC, center=(S/2, S/2))
    front = Image.alpha_composite(front, bars)
    out = Image.alpha_composite(out, front)
    # mask to the squircle so the shadow doesn't leak
    final = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    final.paste(out, (0, 0), rounded_mask((S, S), int(S*0.225)))
    return final.resize((px, px), Image.LANCZOS)

def font(size):
    for f in ("C:/Windows/Fonts/seguisb.ttf", "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"):
        if os.path.exists(f): return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def logo(h, text_color):
    S = h * SS
    ic = icon(h).resize((S, S), Image.LANCZOS)
    f = font(int(S*0.46))
    text = "Loyalty Hub"
    tw = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=f)
    gap = int(S*0.22)
    W = S + gap + (tw[2]-tw[0]) + int(S*0.05)
    out = Image.new("RGBA", (W, S), (0, 0, 0, 0))
    out.paste(ic, (0, 0), ic)
    d = ImageDraw.Draw(out)
    d.text((S+gap - tw[0], (S - (tw[3]-tw[1]))/2 - tw[1]), text, font=f, fill=text_color)
    return out.resize((W//SS, h), Image.LANCZOS)

icon(256).save(os.path.join(OUT, "icon.png"), optimize=True)
icon(512).save(os.path.join(OUT, "icon@2x.png"), optimize=True)
logo(128, (33, 33, 48, 255)).save(os.path.join(OUT, "logo.png"), optimize=True)
logo(256, (33, 33, 48, 255)).save(os.path.join(OUT, "logo@2x.png"), optimize=True)
logo(128, (240, 240, 250, 255)).save(os.path.join(OUT, "dark_logo.png"), optimize=True)
logo(256, (240, 240, 250, 255)).save(os.path.join(OUT, "dark_logo@2x.png"), optimize=True)
# preview sheet
pv = Image.new("RGBA", (900, 420), (245, 245, 248, 255))
pv.paste(icon(256), (30, 30), icon(256))
lg = logo(128, (33, 33, 48, 255)); pv.paste(lg, (320, 40), lg)
dk = Image.new("RGBA", (580, 180), (28, 28, 32, 255)); dl = logo(128, (240, 240, 250, 255)); dk.paste(dl, (20, 26), dl)
pv.paste(dk, (300, 210))
pv.convert("RGB").save(os.path.join(OUT, "_preview.png"))
print("done")
