"""
The low-poly people Previs blocks with: a man, a woman, a boy and a girl.

    Blender -b --factory-startup --python scripts/make-previs-people.py -- backend/assets/previs-library/people [preview.png]

Made here rather than downloaded, so there is no licence to track and the
proportions are ours. "A bit realistic within low-poly, not just blocky": each
figure is a SKELETON in real proportions with a body grown over it by Blender's
skin modifier (tapered thighs and calves, a waist, a chest, shoulders), smoothed
once and reduced to a clean low-poly count, plus a shaped head with a nose,
hands and shoes. Clothing is flat colour by region, not texture.

Heights are real and the head-to-height ratio changes with age: about 1:7.5 for
an adult, 1:6 for a child of eight, so a child reads as a child and not as a
small adult. Each figure stands on z = 0, faces +Y (Film Engine's yaw 0), and is
exported as a GLB in metres.
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
OUT = args[0]
PREVIEW = args[1] if len(args) > 1 else None
os.makedirs(OUT, exist_ok=True)

# Every length is a fraction of height, so one table serves every age.
ADULT = dict(ankle=0.045, knee=0.285, hip=0.515, waist=0.615, chest=0.715, shoulder=0.815, neck=0.845,
             head_c=0.935, head_r=0.066, arm_len=0.335)
CHILD = dict(ankle=0.045, knee=0.275, hip=0.49, waist=0.585, chest=0.68, shoulder=0.775, neck=0.81,
             head_c=0.915, head_r=0.085, arm_len=0.32)

PEOPLE = {
    'man':   dict(height=1.78, p=ADULT, shoulder_w=0.128, hip_w=0.088, waist_w=0.080, chest_w=0.105, chest_d=0.068,
                  limb=1.0, top='#4d6680', legs='#34373d', shoes='#2a2622', hair='short'),
    'woman': dict(height=1.65, p=ADULT, shoulder_w=0.112, hip_w=0.098, waist_w=0.070, chest_w=0.095, chest_d=0.070,
                  limb=0.9, top='#8a4f6f', legs='#3a3d44', shoes='#3b2c2a', hair='long'),
    'boy':   dict(height=1.28, p=CHILD, shoulder_w=0.118, hip_w=0.085, waist_w=0.082, chest_w=0.100, chest_d=0.068,
                  limb=1.0, top='#3f8a7e', legs='#3f4a60', shoes='#2d2d2f', hair='short'),
    'girl':  dict(height=1.26, p=CHILD, shoulder_w=0.114, hip_w=0.088, waist_w=0.078, chest_w=0.096, chest_d=0.066,
                  limb=0.95, top='#d06a58', legs='#4a4f6a', shoes='#5a3a44', hair='long'),
}
SKIN = '#cfc9c2'
HAIR = '#4a3a2e'


def mat(name, hexc, rough=0.8):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    rgb = tuple(int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    m.diffuse_color = (*rgb, 1)
    return m


def body(P):
    """The skeleton, and the skin modifier's radius at every joint."""
    H, p = P['height'], P['p']
    z = {k: v * H for k, v in p.items() if k not in ('head_r', 'arm_len')}
    L = P['limb']
    verts, radii, edges, labels = [], [], [], []

    def v(co, rx, ry=None):
        verts.append(Vector(co)); radii.append((rx * H, (ry if ry is not None else rx) * H))
        return len(verts) - 1

    # spine: pelvis → waist → chest → shoulders line → neck
    pelvis = v((0, 0, z['hip'] + 0.02 * H), P['hip_w'], 0.062)
    waist = v((0, 0.004 * H, z['waist']), P['waist_w'], 0.052)
    chest = v((0, 0.008 * H, z['chest']), P['chest_w'], P['chest_d'])
    upper = v((0, 0, z['shoulder'] - 0.012 * H), P['chest_w'] * 0.92, 0.055)
    neck = v((0, 0.004 * H, z['neck'] + 0.02 * H), 0.030, 0.032)
    edges += [(pelvis, waist), (waist, chest), (chest, upper), (upper, neck)]
    labels += ['hips', 'top', 'top', 'skin']
    for s in (-1, 1):
        # legs: hip joint, upper thigh, knee, calf, ankle
        hx = s * P['hip_w'] * 0.62 * H
        hj = v((hx, 0, z['hip']), 0.058 * L, 0.060 * L)
        thigh = v((hx * 0.98, 0.004 * H, (z['hip'] + z['knee']) / 2 + 0.03 * H), 0.052 * L)
        knee = v((hx * 0.92, 0.006 * H, z['knee']), 0.033 * L)
        calf = v((hx * 0.90, -0.004 * H, (z['knee'] + z['ankle']) / 2 + 0.035 * H), 0.035 * L)
        ankle = v((hx * 0.88, 0, z['ankle'] + 0.012 * H), 0.019 * L)
        edges += [(pelvis, hj), (hj, thigh), (thigh, knee), (knee, calf), (calf, ankle)]
        labels += ['legs'] * 5
        # arms hang with a slight bend and a little away from the hips
        sx = s * P['shoulder_w'] * H
        sh = v((sx, 0, z['shoulder'] - 0.018 * H), 0.034 * L)
        a = p['arm_len'] * H
        elbow = v((sx + s * 0.018 * H, 0.004 * H, z['shoulder'] - a * 0.55), 0.024 * L)
        bicep = v(((verts[sh].x + verts[elbow].x) / 2, 0, (verts[sh].z + verts[elbow].z) / 2), 0.030 * L)
        wrist = v((sx + s * 0.03 * H, 0.03 * H, z['shoulder'] - a * 1.0), 0.017 * L)
        forearm = v(((verts[elbow].x + verts[wrist].x) / 2, 0.018 * H, (verts[elbow].z + verts[wrist].z) / 2), 0.023 * L)
        hand = v((sx + s * 0.034 * H, 0.036 * H, z['shoulder'] - a * 1.0 - 0.06 * H), 0.022 * L, 0.012 * L)
        edges += [(upper, sh), (sh, bicep), (bicep, elbow), (elbow, forearm), (forearm, wrist), (wrist, hand)]
        labels += ['top', 'top', 'skin', 'skin', 'skin', 'skin']
    return verts, radii, edges, labels


def classify(c, P, bones):
    """Which region a face belongs to: the region of the NEAREST bone, measured
    to the surface (distance minus that bone's radius). By height alone, a hand
    hanging below the hip line came out trouser-coloured."""
    H, p = P['height'], P['p']
    best, label = None, 'top'
    for a, b, ra, rb, lab in bones:
        ab = b - a
        t = max(0.0, min(1.0, (c - a).dot(ab) / max(ab.length_squared, 1e-9)))
        d = (c - (a + ab * t)).length - (ra + (rb - ra) * t)
        if best is None or d < best:
            best, label = d, lab
    if label == 'hips':      # the pelvis bone: trousers below the waistband
        label = 'legs' if c.z < (p['hip'] + 0.045) * H else 'top'
    return label


def person(name, P):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    H, p = P['height'], P['p']
    verts, radii, edges, labels = body(P)
    bones = [(verts[i], verts[j], max(radii[i]), max(radii[j]), lab) for (i, j), lab in zip(edges, labels)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], edges, [])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    sk = o.modifiers.new('skin', 'SKIN')
    sk.use_smooth_shade = True
    for i, (rx, ry) in enumerate(radii):
        me.skin_vertices[0].data[i].radius = (rx, ry)
    me.skin_vertices[0].data[0].use_root = True
    sub = o.modifiers.new('smooth', 'SUBSURF')
    sub.levels = 1
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)

    mats = {'top': mat('top', P['top']), 'legs': mat('legs', P['legs']), 'shoes': mat('shoes', P['shoes'], 0.6),
            'skin': mat('skin', SKIN), 'hair': mat('hair', HAIR, 0.9)}
    order = list(mats)
    for m in order:
        o.data.materials.append(mats[m])
    for f in o.data.polygons:
        f.material_index = order.index(classify(f.center, P, bones))

    parts = [o]
    # head: a slightly egg-shaped sphere, jaw narrower than the crown
    hr = p['head_r'] * H
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=hr, location=(0, 0.004 * H, p['head_c'] * H))
    head = bpy.context.object
    head.scale = (0.84, 0.95, 1.08)
    bm = bmesh.new(); bm.from_mesh(head.data)
    for vv in bm.verts:
        if vv.co.z < 0:          # taper toward the chin
            k = 1 - 0.28 * (-vv.co.z / hr)
            vv.co.x *= k; vv.co.y *= (1 - 0.12 * (-vv.co.z / hr))
    bm.to_mesh(head.data); bm.free()
    head.data.materials.append(mats['skin'])
    parts.append(head)
    # nose and ears, so the facing reads
    bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=hr * 0.16, radius2=hr * 0.02, depth=hr * 0.34,
                                    location=(0, 0.004 * H + hr * 0.9, p['head_c'] * H - hr * 0.08))
    nose = bpy.context.object; nose.rotation_euler = (math.radians(-80), 0, 0)
    nose.data.materials.append(mats['skin']); parts.append(nose)
    for s in (-1, 1):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=6, ring_count=4, radius=hr * 0.18,
                                             location=(s * hr * 0.83, 0, p['head_c'] * H - hr * 0.05))
        ear = bpy.context.object; ear.scale = (0.35, 0.8, 1.0)
        ear.data.materials.append(mats['skin']); parts.append(ear)
    # shoes: a rounded box forward of each ankle
    for s in (-1, 1):
        # tall enough to swallow the ankle, so the leg and the shoe meet
        bpy.ops.mesh.primitive_cube_add(size=1, location=(s * P['hip_w'] * 0.55 * H, 0.03 * H, 0.032 * H))
        shoe = bpy.context.object; shoe.scale = (0.05 * H, 0.14 * H, 0.064 * H)
        bev = shoe.modifiers.new('b', 'BEVEL'); bev.width = 0.012 * H; bev.segments = 2
        bpy.context.view_layer.objects.active = shoe
        bpy.ops.object.modifier_apply(modifier='b')
        shoe.data.materials.append(mats['shoes']); parts.append(shoe)
    # hair: a cap for short hair; a cap and a fall down the back for long
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=hr * 1.06,
                                         location=(0, -hr * 0.06, p['head_c'] * H + hr * 0.08))
    cap = bpy.context.object; cap.scale = (0.88, 0.98, 1.0)
    bm = bmesh.new(); bm.from_mesh(cap.data)
    # keep the top and back; cut away the face and below the ears
    doomed = [vv for vv in bm.verts if vv.co.z < -hr * (0.15 if P['hair'] == 'short' else 0.45)
              or (vv.co.y > hr * 0.35 and vv.co.z < hr * 0.55)]
    bmesh.ops.delete(bm, geom=doomed, context='VERTS'); bm.to_mesh(cap.data); bm.free()
    cap.data.materials.append(mats['hair']); parts.append(cap)
    if P['hair'] == 'long':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=hr,
                                             location=(0, -hr * 0.45, p['head_c'] * H - hr * 1.0))
        fall = bpy.context.object; fall.scale = (0.85, 0.42, 1.25)
        fall.data.materials.append(mats['hair']); parts.append(fall)

    bpy.ops.object.select_all(action='DESELECT')
    for q in parts:
        q.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.join()
    # Low-poly: decimated to a count a scene of twenty people can carry.
    dec = o.modifiers.new('lowpoly', 'DECIMATE')
    dec.ratio = min(1.0, 2600 / max(1, len(o.data.polygons)))
    bpy.ops.object.modifier_apply(modifier='lowpoly')
    bpy.ops.object.shade_flat()
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True,
                              export_draco_mesh_compression_enable=False)
    print('WROTE', path, len(o.data.polygons), 'faces', f'{H} m')
    return path


paths = [person(n, P) for n, P in PEOPLE.items()]

if PREVIEW:
    # Front and back, lit, so a person can judge them at a glance.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    for i, pth in enumerate(paths):
        for j, turn in enumerate((0, 180)):
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=pth)
            for ob in set(bpy.data.objects) - before:
                if ob.parent is None:
                    ob.rotation_mode = 'XYZ'   # the importer leaves quaternions, which rotation_euler ignores
                    ob.location.x += (i * 2 + j) * 0.72 - 2.5
                    ob.rotation_euler[2] += math.radians(turn + 180)
    cam = bpy.data.cameras.new('c'); cam.lens = 45
    co = bpy.data.objects.new('c', cam); sc.collection.objects.link(co)
    co.location = (0.02, -7.4, 1.05); co.rotation_euler = (math.radians(88), 0, 0); sc.camera = co
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading; sh.color_type = 'MATERIAL'; sh.light = 'STUDIO'; sh.show_shadows = True
    sc.render.resolution_x, sc.render.resolution_y = 1400, 620
    sc.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
