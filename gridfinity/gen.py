"""Gridfinity-Kästchen mit Nummer (für Bambu Lab A1 mini) und 4x4-Grundplatte (lite).
Maße nach Gridfinity-Standard (Zack Freedman): Raster 42 mm, Höheneinheit 7 mm."""
import sys, numpy as np
from manifold3d import Manifold, CrossSection, JoinType, FillRule
from matplotlib.textpath import TextPath
from matplotlib.font_manager import FontProperties
import trimesh

G = 42.0          # Rastermaß
CLR = 0.25        # Spiel je Seite -> Kästchen 41.5
WALL = 1.2
U = 4             # Höhe in 7-mm-Einheiten -> 28 mm
SEG = 48

def rrect(w, h, r):
    r = max(r, 0.01)
    return CrossSection.square([w - 2 * r, h - 2 * r], center=True).offset(r, JoinType.Round, circular_segments=SEG)

def slab(w, h, r, z0, z1):
    return rrect(w, h, r).extrude(z1 - z0).translate([0, 0, z0])

def frustum(w0, h0, r0, z0, w1, h1, r1, z1):
    a = slab(w0, h0, r0, z0, z0 + 0.001)
    b = slab(w1, h1, r1, z1 - 0.001, z1)
    return Manifold.batch_hull([a, b])

def foot():
    # Fußprofil eines Rasterfelds: 0.8 Fase, 1.8 senkrecht, 2.15 Fase -> 4.75 hoch, oben 41.5
    top = G - 2 * CLR
    w2 = top - 2 * 2.15
    w1 = w2 - 2 * 0.8
    return (frustum(w1, w1, 0.8, 0, w2, w2, 1.6, 0.8)
            + slab(w2, w2, 1.6, 0.8, 2.6)
            + frustum(w2, w2, 1.6, 2.6, top, top, 3.75, 4.75))

def text_cs(s, height):
    tp = TextPath((0, 0), s, size=10, prop=FontProperties(family='DejaVu Sans', weight='bold'))
    polys = [p for p in tp.to_polygons() if len(p) >= 3]
    cs = CrossSection([np.asarray(p, float) for p in polys], FillRule.EvenOdd)
    (x0, y0), (x1, y1) = cs.bounds()[:2], cs.bounds()[2:]
    sc = height / (y1 - y0)
    return cs.translate([-(x0 + x1) / 2, -(y0 + y1) / 2]).scale([sc, sc]), (x1 - x0) * sc

def bin_(nx, ny, label):
    H = 7 * U
    W, D = G * nx - 2 * CLR, G * ny - 2 * CLR
    m = Manifold()
    for i in range(nx):
        for j in range(ny):
            m += foot().translate([(i - (nx - 1) / 2) * G, (j - (ny - 1) / 2) * G, 0])
    body = slab(W, D, 3.75, 4.75, H)
    floor = 4.75 + 1.2
    inner = slab(W - 2 * WALL, D - 2 * WALL, 3.75 - WALL, floor, H + 1)
    m = m + body - inner
    iw, idp = W - 2 * WALL, D - 2 * WALL
    # Mulde vorne (y = -), Radius 10 mm
    R = 10.0
    blk = Manifold.cube([iw, R, R]).translate([-iw / 2, -idp / 2, floor])
    cyl = Manifold.cylinder(iw + 2, R, R, SEG * 2).rotate([0, 90, 0]).translate([-iw / 2 - 1, -idp / 2 + R, floor + R])
    m += (blk - cyl)
    # Beschriftungsleiste hinten (y = +), oben bündig, 45° abgestützt
    tab_d = 11.0 if ny == 1 else 13.0
    tab_t = 1.6
    yb = idp / 2
    shelf = Manifold.cube([iw, tab_d, tab_t]).translate([-iw / 2, yb - tab_d, H - tab_t])
    # 45°-Stütze als Prisma
    top_strip = Manifold.cube([iw, tab_d, 0.01]).translate([-iw / 2, yb - tab_d, H - tab_t - 0.01])
    wall_strip = Manifold.cube([iw, 0.01, 0.01]).translate([-iw / 2, yb - 0.01, H - tab_t - tab_d])
    sup = Manifold.batch_hull([top_strip, wall_strip])
    m += shelf + sup
    # Nummer erhaben auf der Leiste (0.6 mm) -> Farbwechsel ab Höhe H möglich
    th = 7.0 if ny == 1 else 9.0
    tcs, tw = text_cs(label, th)
    if tw > iw - 4:
        tcs = tcs.scale([(iw - 4) / tw, (iw - 4) / tw])
    num = tcs.extrude(0.6).translate([0, yb - tab_d / 2, H])
    m += num
    return m

def baseplate(n=4):
    H = 4.65
    S = G * n
    m = slab(S, S, 4, 0, H)
    for i in range(n):
        for j in range(n):
            c = (frustum(36.3, 36.3, 0.8, -0.01, 36.3, 36.3, 0.8, 0.7)  # unten offen
                 + slab(36.3, 36.3, 0.8, -1, 0.7)
                 + frustum(36.3, 36.3, 0.8, 0.7 - 0.001, 37.7, 37.7, 1.85, 0.7)
                 + slab(37.7, 37.7, 1.85, 0.7, 2.5)
                 + frustum(37.7, 37.7, 1.85, 2.5, 42, 42, 4, H + 0.001)
                 + slab(42, 42, 4, H, H + 1))
            m -= c.translate([(i - (n - 1) / 2) * G, (j - (n - 1) / 2) * G, 0])
    return m

def save(m, path):
    mesh = m.to_mesh()
    assert m.status().name == 'NoError' and m.volume() > 0, path
    t = trimesh.Trimesh(vertices=mesh.vert_properties[:, :3], faces=mesh.tri_verts, process=False)
    assert t.is_watertight, path
    t.export(path)
    return t

if __name__ == '__main__':
    out = sys.argv[1]
    info = {}
    t = save(baseplate(), f'{out}/Grundplatte_4x4.stl'); info['Grundplatte_4x4'] = t.extents
    for n in range(501, 509):
        t = save(bin_(1, 1, str(n)), f'{out}/Kaestchen_{n}_1x1.stl'); info[str(n)] = t.extents
    for n in (509, 510):
        t = save(bin_(2, 2, str(n)), f'{out}/Kaestchen_{n}_2x2.stl'); info[str(n)] = t.extents
    for k, v in info.items(): print(k, np.round(v, 2))
