"""
Build a location's set in Blender from a layout, headless.

    Blender -b --factory-startup --python backend/blender-set.py -- <job.json>

The job names the layout, the plates (one per plate camera) and what to make:

    render   Workbench renders from every plate camera, in material colours, to
             hold against the plates. Nothing is projected, so a wall that is
             in the wrong place shows as a wall in the wrong place.
    export   The same set, every surface camera-projected from the plate that
             sees it most squarely and unoccluded, exported as a GLB (no Draco:
             the stage cannot read it) and saved as a .blend beside it.

The layout is what the connected agent wrote from the plates: metres, Blender
axes (x east, y north, z up), a camera's yaw 0 looking north and positive yaw
turning left. The engine validates it before this script ever sees it, so this
script trusts its shape and never decides anything about the set.
"""
import bpy, bmesh, json, math, os, sys
from bpy_extras.object_utils import world_to_camera_view

job = json.load(open(sys.argv[sys.argv.index('--') + 1]))
L = job['layout']
OUT = job['out_dir']
MODE = job['mode']
STYLE = job.get('style', 'clean')
ASSETS = job.get('assets', {})
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = 'METRIC'


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


MATS = {}


def mat(color, rough=0.5, metal=0.0):
    key = (color, round(rough, 2), round(metal, 2))
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new('m_' + color.lstrip('#') + ('_metal' if metal > 0.5 else ''))
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    rgb = hexrgb(color)
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    m.diffuse_color = (*rgb, 1)
    MATS[key] = m
    return m


def box(name, x0, x1, y0, y1, z0, z1, m):
    if x1 - x0 <= 1e-4 or y1 - y0 <= 1e-4 or z1 - z0 <= 1e-4:
        return None
    bpy.ops.mesh.primitive_cube_add(size=1, location=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
    o = bpy.context.object
    o.name = name
    o.scale = (x1 - x0, y1 - y0, z1 - z0)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(m)
    return o


def rbox(name, cx, cy, cz0, length, thick, height, angle, m):
    """A box `length` along a direction at `angle` radians from +x, standing on cz0.
    The rotation is applied into the mesh, so the projection sees plain world coordinates."""
    if length <= 1e-4 or thick <= 1e-4 or height <= 1e-4:
        return None
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, cz0 + height / 2))
    o = bpy.context.object
    o.name = name
    o.scale = (length, thick, height)
    o.rotation_euler = (0, 0, angle)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.data.materials.append(m)
    return o


def floor_plane(name, fx0, fx1, fy0, fy1, z, spec, thickness=0.0):
    cols = spec.get('colors') or [spec.get('color', '#8a8278')]
    if thickness > 0:
        box(name + ' slab', fx0, fx1, fy0, fy1, z - thickness, z - 0.002, mat(cols[0], 0.5))
    bpy.ops.mesh.primitive_plane_add(size=1, location=((fx0 + fx1) / 2, (fy0 + fy1) / 2, z))
    fl = bpy.context.object
    fl.name = name
    fl.scale = (fx1 - fx0, fy1 - fy0, 1)
    bpy.ops.object.transform_apply(scale=True)
    fl.data.materials.append(mat(cols[0], 0.35))
    if spec.get('pattern') == 'checker' and len(cols) > 1:
        tile = float(spec.get('tile', 0.3))
        cuts = int(max(fx1 - fx0, fy1 - fy0) / tile)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.subdivide(number_cuts=max(1, cuts))
        bpy.ops.object.mode_set(mode='OBJECT')
        fl.data.materials.append(mat(cols[1], 0.35))
        for p in fl.data.polygons:
            i = int(math.floor((p.center.x - fx0) / tile))
            j = int(math.floor((p.center.y - fy0) / tile))
            p.material_index = (i + j) % 2
    return fl


# ── the room (optional: one box-shaped room) ────────────────────────────────
R = L.get('room')
T = 0.1
if R:
    x0, x1, y0, y1, H = R['x0'], R['x1'], R['y0'], R['y1'], R['height']
    wall_m = mat(R.get('wall_color', '#c8b89a'))
    ceil_m = mat(R.get('ceiling_color', '#d8cbb0'))
    floor_plane('Floor', x0, x1, y0, y1, 0, R.get('floor', {}) or {})
    if R.get('ceiling', True):
        box('Ceiling', x0, x1, y0, y1, H, H + T, ceil_m)

# A wall runs along one axis; an opening is [from, to] along it and [sill, top]
# up it. The wall is cut around its openings rather than boolean-subtracted,
# so the geometry stays simple quads the projection can texture.
WALLS = {
    'north': dict(axis='x', lo='x0', hi='x1', fixed=('y1', +1)),
    'south': dict(axis='x', lo='x0', hi='x1', fixed=('y0', -1)),
    'east': dict(axis='y', lo='y0', hi='y1', fixed=('x1', +1)),
    'west': dict(axis='y', lo='y0', hi='y1', fixed=('x0', -1)),
}


def room_wall(side):
    spec = WALLS[side]
    edge = R[spec['fixed'][0]]
    fixed = (edge, edge + T) if spec['fixed'][1] > 0 else (edge - T, edge)
    return dict(axis=spec['axis'], lo=R[spec['lo']], hi=R[spec['hi']], fixed=fixed)


def wall_piece(name, w, a, b, z0, z1, m, inset=0.0):
    f0, f1 = w['fixed']
    if inset:
        f0, f1 = (f0 + inset, f0 + inset + 0.02)
    if w['axis'] == 'x':
        return box(name, a, b, f0, f1, z0, z1, m)
    return box(name, f0, f1, a, b, z0, z1, m)


openings = L.get('openings', [])
for side in (WALLS if R else []):
    w = room_wall(side)
    if side in (R.get('open_walls') or []):
        continue
    mine = sorted([o for o in openings if o['wall'] == side], key=lambda o: o['from'])
    cursor = w['lo']
    for k, o in enumerate(mine):
        a, b = max(o['from'], w['lo']), min(o['to'], w['hi'])
        wall_piece(f'{side} wall pier {k}', w, cursor, a, 0, H, wall_m)
        sill = o.get('sill', 0.0)
        top = o.get('top', H)
        wall_piece(f'{side} wall below {k}', w, a, b, 0, sill, wall_m)
        wall_piece(f'{side} wall above {k}', w, a, b, top, H, wall_m)
        frame_m = mat(o.get('frame_color', '#3a2a1e'))
        if o['kind'] == 'window':
            wall_piece(f'{side} window {k} glass', w, a, b, sill, top, mat(o.get('glass_color', '#e8dcc0'), 0.05), inset=0.03)
            n = int(o.get('mullions', 0))
            for m_ in range(1, n + 1):
                xm = a + m_ * (b - a) / (n + 1)
                wall_piece(f'{side} window {k} mullion {m_}', w, xm - 0.04, xm + 0.04, sill, top, frame_m)
        elif o['kind'] == 'door':
            wall_piece(f'{side} door {k}', w, a, b, 0, top, frame_m, inset=0.02)
        cursor = b
    wall_piece(f'{side} wall pier end', w, cursor, w['hi'], 0, H, wall_m)

# ── free walls: anywhere, at any level, each with its own openings ─────────
for wi, W in enumerate(L.get('walls', [])):
    ax, ay = W['from']
    bx, by = W['to']
    length = math.hypot(bx - ax, by - ay)
    ang = math.atan2(by - ay, bx - ax)
    ux, uy = (bx - ax) / length, (by - ay) / length
    z0 = W.get('z0', 0.0)
    h = W['height']
    th = W.get('thickness', 0.12)
    wm = mat(W.get('color', '#c8c4bc'))
    nm = W.get('name') or f'Wall {wi + 1}'

    def piece(label, a, b, pz0, pz1, m, thick=None):
        if b - a <= 1e-4 or pz1 - pz0 <= 1e-4:
            return
        mid = (a + b) / 2
        rbox(f'{nm} {label}', ax + ux * mid, ay + uy * mid, z0 + pz0, b - a, thick or th, pz1 - pz0, ang, m)

    cursor = 0.0
    for k, o in enumerate(sorted(W.get('openings', []), key=lambda o: o['at'])):
        a, b = o['at'], o['at'] + o['width']
        piece(f'pier {k}', cursor, a, 0, h, wm)
        sill, top = o.get('sill', 0.0), o.get('top', h)
        piece(f'below {k}', a, b, 0, sill, wm)
        piece(f'above {k}', a, b, top, h, wm)
        fm = mat(o.get('frame_color', '#e8e4dc'))
        if o['kind'] == 'window':
            piece(f'window {k} glass', a, b, sill, top, mat(o.get('glass_color', '#dfe8ec'), 0.05), thick=0.02)
            n = int(o.get('mullions', 0))
            for m_ in range(1, n + 1):
                xm = a + m_ * (b - a) / (n + 1)
                piece(f'window {k} mullion {m_}', xm - 0.03, xm + 0.03, sill, top, fm, thick=th + 0.01)
        elif o['kind'] == 'door':
            piece(f'door {k}', a, b, 0, top, fm, thick=0.04)
        cursor = b
    piece('pier end', cursor, length, 0, h, wm)

# ── slabs: a floor or ceiling at any level ─────────────────────────────────
for si, SL in enumerate(L.get('slabs', [])):
    floor_plane(SL.get('name') or f'Slab {si + 1}', SL['x0'], SL['x1'], SL['y0'], SL['y1'], SL['z'],
                SL, thickness=SL.get('thickness', 0.2))

# ── stairs: solid steps rising in the direction of yaw ─────────────────────
for ti, ST in enumerate(L.get('stairs', [])):
    yaw = math.radians(ST.get('yaw', 0))
    dx, dy = -math.sin(yaw), math.cos(yaw)        # yaw 0 climbs north, 90 west
    sx, sy, sz = ST['at']
    n = ST['steps']
    tread, riser = ST['run'] / n, ST['rise'] / n
    sm = mat(ST.get('color', '#b07a45'), 0.4)
    for i in range(n):
        u = (i + 0.5) * tread
        rbox(f"{ST.get('name') or f'Stair {ti + 1}'} step {i + 1}", sx + dx * u, sy + dy * u, sz,
             ST['width'], tread, (i + 1) * riser, yaw, sm)

# ── library and project models, fitted to a real size ──────────────────────
def place_asset(ob, nm, cx, cy, cz):
    """Import a GLB, join it, fit its bounds to `size` (width x, depth y, height z),
    stand its base centre at (cx, cy, cz) and turn it to `yaw` (0 faces north)."""
    from mathutils import Vector, Matrix
    key = f"lib:{ob['asset']}" if ob.get('asset') else f"model:{ob['asset_id']}"
    spec = ASSETS[key]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=spec['path'])
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    if not meshes:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = nm
    vs = [v.co for v in o.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    size = ob.get('size') or spec['size']
    dims = hi - lo
    sx, sy, sz = (size[0] / max(dims.x, 1e-6), size[1] / max(dims.y, 1e-6), size[2] / max(dims.z, 1e-6))
    base = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    # glTF models face -Z, which the importer turns into +Y: yaw 0 already faces north.
    m = (Matrix.Translation((cx, cy, cz)) @ Matrix.Rotation(math.radians(ob.get('yaw', 0)), 4, 'Z')
         @ Matrix.Diagonal((sx, sy, sz, 1)) @ Matrix.Translation(-base))
    o.data.transform(m)
    o.matrix_world = Matrix.Identity(4)
    return o


# ── objects ─────────────────────────────────────────────────────────────────
for ob in L.get('objects', []):
    rep = ob.get('repeat') or {}
    count = int(rep.get('count', 1))
    step = rep.get('step', [0, 0, 0])
    m = mat(ob.get('color', '#888888'), ob.get('rough', 0.5), ob.get('metal', 0.0))
    for i in range(count):
        cx = ob['at'][0] + step[0] * i
        cy = ob['at'][1] + step[1] * i
        cz = ob['at'][2] + step[2] * i
        nm = ob['name'] if count == 1 else f"{ob['name']} {i + 1}"
        if ob['shape'] == 'box':
            w_, d_, h_ = ob['size']
            o = box(nm, cx - w_ / 2, cx + w_ / 2, cy - d_ / 2, cy + d_ / 2, cz, cz + h_, m)
            if o and ob.get('yaw'):
                o.rotation_euler[2] = math.radians(ob['yaw'])
        elif ob['shape'] == 'cylinder':
            r, h_ = ob['radius'], ob['height']
            bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h_, location=(cx, cy, cz + h_ / 2), vertices=24)
            o = bpy.context.object
            o.name = nm
            o.data.materials.append(m)
        elif ob['shape'] == 'asset':
            place_asset(ob, nm, cx, cy, cz)
        elif ob['shape'] == 'sphere':
            r = ob['radius']
            bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=(cx, cy, cz + r), segments=24, ring_count=12)
            o = bpy.context.object
            o.name = nm
            o.data.materials.append(m)

# ── plate cameras ───────────────────────────────────────────────────────────
PLATES = job['plates']   # [{ view, path, width, height }]
cams = []
for c in L['cameras']:
    plate = next(p for p in PLATES if p['view'] == c['plate'])
    cam = bpy.data.cameras.new('plate ' + c['plate'])
    cam.lens = c.get('lens', 24)
    cam.sensor_width = 36
    cam.sensor_fit = 'HORIZONTAL'
    o = bpy.data.objects.new('Plate camera ' + c['plate'], cam)
    sc.collection.objects.link(o)
    o.location = c['position']
    if c.get('rotation'):
        # A camera solved from video: its own camera-to-world rotation, exactly.
        from mathutils import Matrix
        o.rotation_euler = Matrix(c['rotation']).to_euler()
    else:
        o.rotation_euler = (math.radians(90 + c.get('pitch', 0)), math.radians(c.get('roll', 0)), math.radians(c.get('yaw', 0)))
    cams.append((o, plate))

# ── light that follows the location: a sun through the windows, by time of day ─
LIGHT = L.get('light') or {}
ELEVATION = {'morning': 18, 'midday': 60, 'afternoon': 35, 'evening': 9, 'night': None}
FROM = {'north': 0, 'west': 90, 'south': 180, 'east': -90}
elev = ELEVATION.get(LIGHT.get('time_of_day', 'afternoon'), 35)
if elev is not None:
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.energy = 3.0
    sun.angle = math.radians(2)
    if LIGHT.get('time_of_day') == 'evening':
        sun.color = (1.0, 0.78, 0.55)
    so = bpy.data.objects.new('Sun', sun)
    sc.collection.objects.link(so)
    # The light travels AWAY from the side it comes in from.
    az = math.radians(FROM.get(LIGHT.get('sun_from', 'south'), 180))
    so.rotation_euler = (math.radians(90 - elev), 0, az)
else:
    for k, (x, y) in enumerate([(0, 0)]):
        lamp = bpy.data.lights.new('Night lamp', 'POINT')
        lamp.energy = 400
        lamp.color = (1.0, 0.8, 0.6)
        lo_ = bpy.data.objects.new('Night lamp', lamp)
        sc.collection.objects.link(lo_)
        lo_.location = (x, y, 2.4)


# ── projection ──────────────────────────────────────────────────────────────
def densify(max_edge=0.35):
    for o in [o for o in sc.objects if o.type == 'MESH']:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        for _ in range(6):
            long = [e for e in bm.edges if e.calc_length() > max_edge]
            if not long:
                break
            bmesh.ops.subdivide_edges(bm, edges=long, cuts=1, use_grid_fill=True)
        bm.to_mesh(o.data)
        bm.free()


def set_res(plate):
    sc.render.resolution_x, sc.render.resolution_y = plate['width'], plate['height']


def project():
    """Each face takes the plate that sees it most squarely, unoccluded; its UVs
    are its vertices seen through that camera. A face no plate sees keeps its
    material colour, which is the honest answer for a side nobody photographed."""
    dg = bpy.context.evaluated_depsgraph_get()
    plate_mats = []
    for cam, plate in cams:
        img = bpy.data.images.load(plate['path'])
        img.pack()
        m = bpy.data.materials.new('Plate ' + plate['view'])
        m.use_nodes = True
        nt = m.node_tree
        b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        tx = nt.nodes.new('ShaderNodeTexImage')
        tx.image = img
        nt.links.new(tx.outputs['Color'], b.inputs['Base Color'])
        b.inputs['Roughness'].default_value = 0.8
        plate_mats.append((cam, plate, m))
    stats = {p['view']: 0 for _, p in cams}
    stats['unseen'] = 0
    for o in [o for o in sc.objects if o.type == 'MESH']:
        me = o.data
        mw = o.matrix_world
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        uv = me.uv_layers.active.data
        idx = {}
        for cam, plate, m in plate_mats:
            me.materials.append(m)
            idx[cam.name] = len(me.materials) - 1
        for p in me.polygons:
            c = mw @ p.center
            n = (mw.to_3x3() @ p.normal).normalized()
            best = None
            for cam, plate, m in plate_mats:
                set_res(plate)
                d = c - cam.matrix_world.translation
                dist = d.length
                facing = -n.dot(d.normalized())
                if facing < 0.08:
                    continue
                v = world_to_camera_view(sc, cam, c)
                if not (0 <= v.x <= 1 and 0 <= v.y <= 1 and v.z > 0):
                    continue
                hit, loc, *_ = sc.ray_cast(dg, cam.matrix_world.translation, d.normalized(), distance=dist + 0.05)
                if hit and (loc - c).length > 0.06:
                    continue
                score = facing / (1 + dist * 0.05)
                if not best or score > best[0]:
                    best = (score, cam, plate)
            if not best:
                stats['unseen'] += 1
                continue
            _, cam, plate = best
            stats[plate['view']] += 1
            set_res(plate)
            p.material_index = idx[cam.name]
            for li in p.loop_indices:
                w = world_to_camera_view(sc, cam, mw @ me.vertices[me.loops[li].vertex_index].co)
                uv[li].uv = (w.x, w.y)
    return stats


def sample_palette():
    """The clean look: every object one flat colour, the median of what the plates
    show on the faces they see, unoccluded. An object no plate sees keeps the
    colour its layout gave it. A patterned floor keeps its pattern."""
    import numpy as np
    dg = bpy.context.evaluated_depsgraph_get()
    pixels = {}
    for cam, plate in cams:
        img = bpy.data.images.load(plate['path'])
        arr = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(arr)
        pixels[cam.name] = (arr.reshape(img.size[1], img.size[0], 4), img.size[0], img.size[1])
    out = {}
    for o in [o for o in sc.objects if o.type == 'MESH']:
        if len(o.data.materials) != 1:
            continue
        mw = o.matrix_world
        samples = []
        for p in o.data.polygons:
            c = mw @ p.center
            n = (mw.to_3x3() @ p.normal).normalized()
            for cam, plate in cams:
                set_res(plate)
                d = c - cam.matrix_world.translation
                if -n.dot(d.normalized()) < 0.15:
                    continue
                v = world_to_camera_view(sc, cam, c)
                if not (0.02 <= v.x <= 0.98 and 0.02 <= v.y <= 0.98 and v.z > 0):
                    continue
                hit, loc, *_ = sc.ray_cast(dg, cam.matrix_world.translation, d.normalized(), distance=d.length + 0.05)
                if hit and (loc - c).length > 0.06:
                    continue
                px, w, h = pixels[cam.name]
                samples.append(px[min(h - 1, int(v.y * h)), min(w - 1, int(v.x * w)), :3])
        if len(samples) < 3:
            continue
        col = np.median(np.array(samples), axis=0)
        base = o.data.materials[0]
        m = bpy.data.materials.new('Sampled ' + o.name)
        m.use_nodes = True
        b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        bb = next(n for n in base.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        b.inputs['Base Color'].default_value = (*col, 1)
        b.inputs['Roughness'].default_value = bb.inputs['Roughness'].default_value
        m.diffuse_color = (*col, 1)
        o.data.materials[0] = m
        out[o.name] = [round(float(x), 3) for x in col]
    return out


result = {'mode': MODE, 'renders': {}, 'objects': len([o for o in sc.objects if o.type == 'MESH'])}
if MODE == 'render':
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'MATERIAL'
    sh.show_shadows = True
    sh.show_cavity = True
    for cam, plate in cams:
        set_res(plate)
        sc.camera = cam
        path = os.path.join(OUT, f"render_{plate['view']}.png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        result['renders'][plate['view']] = path
elif MODE == 'export':
    densify()
    if STYLE == 'painted':
        result['faces'] = project()
    else:
        result['palette'] = sample_palette()
    glb = os.path.join(OUT, 'set.glb')
    bpy.ops.object.select_all(action='DESELECT')
    for o in sc.objects:
        o.select_set(o.type in ('MESH', 'LIGHT'))
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_yup=True,
                              export_apply=True, export_cameras=False, export_lights=True,
                              export_draco_mesh_compression_enable=False)
    result['glb'] = glb
    blend = os.path.join(OUT, 'set.blend')
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    result['blend'] = blend

with open(os.path.join(OUT, f'result_{MODE}.json'), 'w') as f:
    json.dump(result, f)
print('SET-BUILD-DONE')
