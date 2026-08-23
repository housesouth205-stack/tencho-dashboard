import sys, re
sys.path.insert(0,".")
from ccitt import decode_g4
from imgtool import crop_scale, write_gray

def images(path):
    b=open(path,"rb").read()
    out=[]
    for m in re.finditer(rb"<<(?:(?!>>).)*?/Subtype/Image(?:(?!stream).)*?>>\s*stream\r?\n", b, re.S):
        d=m.group(0)
        w=int(re.search(rb"/Width (\d+)",d).group(1)); h=int(re.search(rb"/Height (\d+)",d).group(1))
        L=int(re.search(rb"/Length (\d+)",d).group(1)); st=m.end()
        out.append((w,h,b[st:st+L]))
    return out

if __name__ == "__main__":
    path, idx, scale = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    tag = sys.argv[4]
    box = [int(x) for x in sys.argv[5:9]] if len(sys.argv) > 8 else None
    w,h,data = images(path)[idx]
    px,rows = decode_g4(data, w, h)
    b = box or (0,0,w,rows)
    g,ow,oh = crop_scale(px, w, rows, b, scale)
    write_gray(tag, g, ow, oh)
    print(tag, ow, oh, "src", w, rows)
