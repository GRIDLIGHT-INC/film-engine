"""
Render a shot's previz move through its set, headless.

    Blender -b --factory-startup --python backend/blender-previz.py -- <job.json>

The job is planned in Node (lib/previs-video.js) and already in Blender's
axes (x east, y north, z up): the world GLB to stand in, the staged people and
models with the GLB each is drawn from and its real size, and one entry per
frame with the camera's eye, the point it looks at, its roll and lens, and
where each staged subject stands and faces. This script decides nothing about
the shot; it places what it is told and renders Workbench frames to PNG.
ffmpeg turns them into the MP4, in Node.
"""
import bpy, json, math, os, sys
from mathutils import Vector, Matrix

job = json.load(open(sys.argv[sys.argv.index('--') + 1]))
OUT = job['out_dir']
FRAMES_DIR = os.path.join(OUT, 'frames')
os.makedirs(FRAMES_DIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = 'METRIC'


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


# ── the set ─────────────────────────────────────────────────────────────────
if job.get('world_glb'):
    for o in import_glb(job['world_glb']):
        # Workbench draws no lights; the set's own exported cameras are not ours.
        if o.type in ('LIGHT', 'CAMERA'):
            bpy.data.objects.remove(o, do_unlink=True)


# ── the staged subjects, each under one empty that is moved per frame ──────
def subject_rig(i, spec):
    holder = bpy.data.objects.new(f"subject_{i}", None)
    sc.collection.objects.link(holder)
    meshes = []
    if spec.get('glb'):
        new = import_glb(spec['glb'])
        meshes = [o for o in new if o.type == 'MESH']
        for o in new:
            if o.type != 'MESH':
                bpy.data.objects.remove(o, do_unlink=True)
    if meshes:
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.make_single_user(type='SELECTED_OBJECTS', object=True, obdata=True)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        if len(meshes) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
    else:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
        o = bpy.context.view_layer.objects.active
        m = bpy.data.materials.new(f"subject_{i}_m")
        m.diffuse_color = (0.6, 0.6, 0.64, 1)
        o.data.materials.append(m)
    vs = [v.co for v in o.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    dims = hi - lo
    w, d, h = spec['size']                      # width x, depth y, height z (Blender axes)
    if spec.get('fit'):
        k = h / max(dims.z, 1e-6)
        scale = (k, k, k)
    else:
        scale = (w / max(dims.x, 1e-6), d / max(dims.y, 1e-6), h / max(dims.z, 1e-6))
    base = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    # glTF models face -Z, which the importer turns into +Y: yaw 0 already faces north.
    o.data.transform(Matrix.Diagonal((*scale, 1)) @ Matrix.Translation(-base))
    o.matrix_world = Matrix.Identity(4)
    o.parent = holder
    return holder


holders = [subject_rig(i, s) for i, s in enumerate(job.get('subjects', []))]

# ── the camera ──────────────────────────────────────────────────────────────
cam_data = bpy.data.cameras.new('previz')
cam_data.sensor_fit = 'HORIZONTAL'
cam_data.sensor_width = float(job.get('sensor_width_mm', 36))
cam_data.clip_start = 0.05
cam_data.clip_end = 1000
cam = bpy.data.objects.new('previz', cam_data)
sc.collection.objects.link(cam)
sc.camera = cam

sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading
sh.light = 'STUDIO'
sh.color_type = 'MATERIAL'
try:
    sh.show_shadows = True
    sh.show_cavity = True
except Exception:
    pass
sc.render.resolution_x = int(job['width'])
sc.render.resolution_y = int(job['height'])
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'PNG'
sc.render.film_transparent = False
if sc.world is None:
    sc.world = bpy.data.worlds.new('previz')
sc.world.color = (0.08, 0.08, 0.09)

frames = job['frames']
n = len(frames)
for i, fr in enumerate(frames):
    c = fr['cam']
    eye = Vector(c['eye'])
    look = Vector(c['target']) - eye
    if look.length < 1e-6:
        look = Vector((0, 1, 0))
    q = look.to_track_quat('-Z', 'Y')
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = q @ Matrix.Rotation(math.radians(c.get('roll', 0)), 4, 'Z').to_quaternion()
    cam.location = eye
    cam_data.lens = float(c['lens_mm'])
    for h, s in zip(holders, fr.get('subjects', [])):
        h.location = Vector(s[:3])
        h.rotation_euler = (0, 0, math.radians(s[3]))
    sc.render.filepath = os.path.join(FRAMES_DIR, 'frame_%05d.png' % (i + 1))
    bpy.ops.render.render(write_still=True)
    print('PREVIZ-FRAME %d/%d' % (i + 1, n), flush=True)

with open(os.path.join(OUT, 'result_previz.json'), 'w') as f:
    json.dump({'mode': 'previz', 'frames': n, 'frames_dir': FRAMES_DIR}, f)
print('SET-BUILD-DONE')
