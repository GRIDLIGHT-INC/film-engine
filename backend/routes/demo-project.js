/**
 * Demo project seeder — "Neon Requiem"
 * POST /film/projects/demo — Creates a fully populated demo project
 */
const { db, generateId } = require('../db/database');

const FOUNTAIN_SCREENPLAY = `Title: Neon Requiem
Credit: Written by
Author: Gridlight Demo
Draft date: 2026-01-15
Contact: demo@gridlight.dev

# ACT ONE

= A burned-out detective in a neon-drenched city picks up a case that will change everything.

INT. DETECTIVE'S OFFICE - NIGHT

.FADE IN:

Rain streaks down grimy windows. Neon signs bleed pink and blue through the glass. A ceiling fan turns slowly, casting rhythmic shadows.

KAI NAKAMURA (30s, weathered trenchcoat, tired eyes) sits at a cluttered desk. Half-empty whiskey glass. Case files scattered everywhere. A holographic display flickers with cold case data.

The PHONE RINGS. Kai stares at it. It rings again.

KAI
(into phone)
Nakamura.

LT. TORRES (V.O.)
Kai, we got another one. Third this week. Same signature — neural implant fried from the inside.

KAI
Where?

LT. TORRES (V.O.)
Neon Alley. Behind the Chrome Lounge. Kai... this one's different. Victim had a message carved into the implant housing. Your name.

Kai sets down the glass. Grabs the trenchcoat.

KAI
I'm on my way.

EXT. NEON ALLEY - NIGHT

Rain hammers the pavement. Holographic advertisements shimmer in puddles. Steam rises from grates. The alley is a canyon of light and shadow.

Kai walks through the crime scene tape. Police drones hover overhead, scanning. A FIGURE emerges from the shadows.

CIPHER (20s, neon-lit jacket, augmented eyes that glow faintly green) leans against a wall, hood up.

CIPHER
Detective Nakamura. I was hoping you'd come personally.

KAI
Do I know you?

CIPHER
No. But I know who's killing these people. And I know why they left your name on that body.

Kai steps closer, hand near the holster.

CIPHER
It's called the Prometheus Protocol. An underground syndicate experimenting with artificial consciousness. They're not just frying implants, detective. They're uploading minds.

KAI
Uploading minds. Right. And Santa Claus runs the grid.

CIPHER
The Chrome Lounge. Tonight. A man named Vex. He's the architect. See for yourself.

Cipher drops a data chip and vanishes into the rain.

INT. CHROME LOUNGE - NIGHT

Bass thrums through the walls. The lounge is sleek and dangerous — chrome surfaces reflect shifting holographic art. A circular bar glows electric blue.

Kai enters, scanning the room. At a VIP booth in the back: VEX (40s, silver hair slicked back, expensive suit, calm predator's eyes) holds court with two bodyguards.

Kai approaches. The bodyguards tense.

VEX
Detective Nakamura. I've been expecting you. Please, sit.

KAI
Three people are dead. Neural implants burned out. Your name keeps surfacing.

VEX
(sipping drink)
People die in this city every day, detective. I'm a businessman. I provide... upgrades. Consciousness enhancement. The next step in human evolution.

KAI
Sounds like murder with extra steps.

VEX
(leaning forward)
What if I told you death is just a transition? That every one of those "victims" volunteered? That right now, their consciousness exists in a digital paradise of my creation?

KAI
I'd say you're insane.

VEX
Then you're not ready. But you will be. Your name on that implant wasn't a threat, detective. It was an invitation.

# ACT TWO

= The investigation deepens as Kai discovers the terrifying scope of the Prometheus Protocol.

EXT. ROOFTOP - NIGHT

Kai pursues a HOODED FIGURE across rain-slicked rooftops. Neon signs flash below. The city stretches endlessly, a grid of light.

The figure leaps between buildings. Kai follows, nearly slipping. They crash through a rooftop greenhouse, glass shattering, plants scattering.

KAI
Stop! Police!

The figure turns — it's a YOUNG WOMAN, eyes blank, neural implant glowing red. She speaks in Vex's voice.

VEX (THROUGH WOMAN)
You see, detective? The body is just hardware. The mind is the software. And I've learned to copy-paste.

The woman collapses. Kai catches her. The implant goes dark.

INT. UNDERGROUND LAB - NIGHT

Cipher leads Kai through hidden tunnels beneath the city. They emerge into a vast underground laboratory. Rows of pods line the walls, each containing a person suspended in blue fluid, neural implants connected to a massive central server.

KAI
How many?

CIPHER
Three hundred and counting. Each one uploaded. Each one's body left as a puppet for Vex's network. He calls them vessels.

KAI
We need to shut this down.

CIPHER
It's not that simple. Pull the plug and three hundred minds are erased. They exist only in the server now. Kill the server, kill them all.

Kai stares at the pods. A WOMAN inside one opens her eyes — blank, unseeing.

KAI
Then we need another way.

# ACT THREE

= The final confrontation at dawn, where Kai must choose between justice and mercy.

EXT. BRIDGE - DAWN

First light breaks through storm clouds. Kai stands at the center of a massive suspension bridge. Vex waits at the other end, calm, hands in pockets.

Between them: a portable server unit. Three hundred uploaded minds.

VEX
You found my garden. Impressive. But you're too late. The upload is permanent. These minds chose transcendence.

KAI
They chose because you manipulated them. Fed them lies about digital paradise.

VEX
Is it a lie if it's true? In my network, there is no pain. No disease. No death. Just pure consciousness, experiencing infinity.

KAI
At the cost of their bodies. Their families. Their humanity.

VEX
Humanity is overrated, detective.

Kai draws the weapon. Vex doesn't flinch.

VEX
Shoot me, and the dead man's switch activates. Server wipes. Three hundred souls — gone. Or... let me walk. I relocate. Continue my work. And those three hundred live forever.

Long pause. Rain drips. Dawn light intensifies.

KAI
There's a third option.

Kai holsters the weapon. Pulls out Cipher's data chip.

KAI
This contains a bridge protocol. Your uploaded minds get transferred to the city's medical grid. Distributed consciousness, monitored by hospitals, not a crime lord. They live. You lose control.

VEX
(genuine fear for the first time)
You can't—

KAI
Cipher already started the transfer. It's done, Vex. It's over.

Vex lunges. Kai sidesteps. They struggle at the bridge railing. Police sirens wail in the distance. Vex breaks free, looks down at the river, then back at Kai.

VEX
This isn't over. Consciousness is the future, Nakamura. You can't stop evolution.

Vex climbs the railing and jumps. Kai rushes to look — a drone catches Vex mid-fall, carrying him into the fog.

INT. DETECTIVE'S OFFICE - DAWN

Golden dawn light replaces the neon. Kai sits at the desk. The holographic display shows: "PROMETHEUS PROTOCOL — CASE CLOSED. 300 MINDS TRANSFERRED TO MEDICAL GRID."

The phone rings. Kai answers.

LT. TORRES (V.O.)
Good work, Kai. Feds are taking over the Vex manhunt. You should get some rest.

KAI
Yeah. Rest.

Kai hangs up. Stares at Cipher's data chip on the desk. Turns it over. On the back, etched tiny: "V2.0 — There are more."

KAI
(to self)
Of course there are.

.FADE OUT.

THE END`;

function handleDemoProject(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    // Prevent duplicate demo projects
    const existing = db.prepare(
        "SELECT id FROM film_projects WHERE title = 'Neon Requiem' LIMIT 1"
    ).get();
    if (existing) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            project_id: existing.id,
            title: 'Neon Requiem',
            already_exists: true,
            message: 'Demo project already exists'
        }));
        return;
    }

    try {
        const result = createDemoProject();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create demo project: ' + err.message }));
    }
}

function createDemoProject() {
    const projectId = generateId();
    const now = new Date().toISOString();

    const seed = db.transaction(() => {
        // ── Project ──────────────────────────────────────────────
        db.prepare(`
            INSERT INTO film_projects (id, title, logline, genre, style_preset, status,
                target_resolution, target_fps, aspect_ratio, color_space,
                delivery_format, timecode_start, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            projectId,
            'Neon Requiem',
            'A burned-out detective in a rain-soaked neon city investigates a series of neural murders linked to an underground AI consciousness syndicate.',
            'neo-noir',
            'cinematic',
            'pre-production',
            '2560x1080', 24, '2.39:1', 'DCI-P3',
            'theatrical_dcp', '01:00:00:00',
            now, now
        );

        // ── Screenplay ──────────────────────────────────────────
        const scriptId = generateId();
        db.prepare(`
            INSERT INTO film_scripts (id, project_id, version, content, word_count,
                format, fountain_content, title_page_json, page_count, scene_count,
                dialogue_percentage, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            scriptId, projectId, 1, FOUNTAIN_SCREENPLAY, 1420,
            'fountain', FOUNTAIN_SCREENPLAY,
            JSON.stringify({ title: 'Neon Requiem', credit: 'Written by', author: 'Gridlight Demo', draft_date: '2026-01-15' }),
            12, 7, 34.5, now
        );

        // ── Characters ──────────────────────────────────────────
        const chars = {};
        const charData = [
            {
                name: 'Kai Nakamura', description: 'Burned-out detective, 30s, haunted by past cases. Wears a weathered trenchcoat. Tired but sharp eyes.',
                appearance_prompt: 'detective 30s male, weathered trenchcoat, tired sharp eyes, short dark hair, rain-soaked, neon-lit, neo-noir cinematic',
                age_range: '30-35', gender: 'male', ethnicity: 'Japanese-American', build: 'lean athletic',
                hair: 'short black', distinguishing: 'scar above left eyebrow, always carries a silver lighter',
                day_rate: 15000, shooting_days: 18, travel_allowance: 5000, actor_name: '', talent_tier: 'lead'
            },
            {
                name: 'Vex', description: 'Antagonist, 40s, silver-haired crime lord and consciousness architect. Calm, sophisticated, terrifying.',
                appearance_prompt: 'villain 40s male, silver slicked-back hair, expensive dark suit, predator eyes, chrome environment, cinematic lighting',
                age_range: '40-45', gender: 'male', ethnicity: 'European', build: 'tall slim',
                hair: 'silver slicked-back', distinguishing: 'always wears a silver ring with circuit pattern, calm predator eyes',
                day_rate: 8000, shooting_days: 10, travel_allowance: 3000, actor_name: '', talent_tier: 'supporting'
            },
            {
                name: 'Cipher', description: 'Young hacker informant, 20s. Neon-lit jacket, augmented eyes that glow green. Street-smart and enigmatic.',
                appearance_prompt: 'hacker 20s androgynous, neon-lit jacket, glowing green augmented eyes, hood up, cyberpunk alley, rain',
                age_range: '22-26', gender: 'non-binary', ethnicity: 'mixed', build: 'slim',
                hair: 'short with neon green tips', distinguishing: 'augmented eyes glow faint green, neon-lit jacket with circuit patterns',
                day_rate: 2000, shooting_days: 5, travel_allowance: 500, actor_name: '', talent_tier: 'day_player'
            },
            {
                name: 'Lt. Torres', description: 'Police lieutenant, 50s. Veteran cop, gruff but cares about the team. Voice of authority.',
                appearance_prompt: 'police lieutenant 50s female, stern but kind face, police uniform, office backdrop, warm lighting',
                age_range: '50-55', gender: 'female', ethnicity: 'Latina', build: 'stocky',
                hair: 'short gray-streaked', distinguishing: 'reading glasses on a chain, always has coffee',
                day_rate: 2000, shooting_days: 3, travel_allowance: 0, actor_name: '', talent_tier: 'day_player'
            }
        ];

        for (const c of charData) {
            const cid = generateId();
            chars[c.name] = cid;
            db.prepare(`
                INSERT INTO film_characters (id, project_id, name, description, appearance_prompt,
                    age_range, gender, ethnicity, build, hair, distinguishing,
                    day_rate, shooting_days, travel_allowance, actor_name, talent_tier, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(cid, projectId, c.name, c.description, c.appearance_prompt,
                c.age_range, c.gender, c.ethnicity, c.build, c.hair, c.distinguishing,
                c.day_rate, c.shooting_days, c.travel_allowance, c.actor_name, c.talent_tier, now, now);
        }

        // ── Costumes ─────────────────────────────────────────────
        const costumeData = [
            { char: 'Kai Nakamura', name: 'Detective Trenchcoat', description: 'Weathered dark brown trenchcoat over black shirt and slacks. Shoulder holster visible.', visual_prompt: 'weathered brown trenchcoat, black shirt, shoulder holster, detective noir', color_palette: '#3d2b1f,#1a1a1a,#555555' },
            { char: 'Vex', name: 'Silver Suit', description: 'Impeccably tailored charcoal suit with silver thread details. Silver circuit-pattern ring.', visual_prompt: 'expensive charcoal suit, silver thread accents, silver ring, crime lord elegant', color_palette: '#2d2d2d,#c0c0c0,#1a1a2e' },
            { char: 'Cipher', name: 'Neon Runner Jacket', description: 'Black hooded jacket with embedded LED fiber optics that glow green and blue. Tactical boots.', visual_prompt: 'cyberpunk hooded jacket with LED strips, neon green glow, tactical boots, hacker aesthetic', color_palette: '#1a1a1a,#00ff88,#3b82f6' },
        ];

        for (const cos of costumeData) {
            db.prepare(`
                INSERT INTO film_costumes (id, project_id, character_id, name, description, visual_prompt, color_palette, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(generateId(), projectId, chars[cos.char], cos.name, cos.description, cos.visual_prompt, cos.color_palette, now);
        }

        // ── Locations ────────────────────────────────────────────
        const locs = {};
        const locData = [
            {
                name: "Kai's Detective Office", description: 'Cramped, cluttered PI office on the 4th floor. Rain-streaked windows look out on neon signs. Ceiling fan, whiskey bottles, case files everywhere.',
                reference_prompt: 'noir detective office, cluttered desk, rain-streaked window, neon glow outside, ceiling fan, dim warm lighting, holographic display',
                lighting_default: 'low key', time_of_day_default: 'night', atmosphere_notes: 'Claustrophobic, intimate. Neon bleeds through windows.',
                daily_rate: 800, prep_days: 1, shoot_days: 3, permits_cost: 200, location_type: 'practical'
            },
            {
                name: 'Neon Alley', description: 'Narrow alley between towering buildings. Holographic ads shimmer. Steam from grates. Crime scene tape. Rain-soaked pavement reflects everything.',
                reference_prompt: 'cyberpunk alley at night, holographic advertisements, steam from grates, rain puddles reflecting neon, crime scene tape',
                lighting_default: 'neon mixed', time_of_day_default: 'night', atmosphere_notes: 'Oppressive, claustrophobic canyon of light. Rain constant.',
                daily_rate: 2000, prep_days: 2, shoot_days: 2, permits_cost: 1500, location_type: 'practical'
            },
            {
                name: 'Chrome Lounge', description: 'Upscale nightclub with chrome surfaces and holographic art. Circular glowing bar. VIP booths in back. Bass-heavy atmosphere.',
                reference_prompt: 'futuristic nightclub, chrome surfaces, holographic art walls, circular glowing blue bar, VIP booth, cinematic lighting',
                lighting_default: 'neon blue', time_of_day_default: 'night', atmosphere_notes: 'Sleek, dangerous. Music thrums through walls. Electric blue dominates.',
                daily_rate: 3500, prep_days: 2, shoot_days: 2, permits_cost: 1000, location_type: 'studio'
            },
            {
                name: 'Underground Lab', description: 'Vast hidden laboratory beneath the city. Rows of suspension pods with blue fluid. Massive central server. Clinical lighting contrasts organic horror.',
                reference_prompt: 'underground sci-fi laboratory, rows of suspension pods with blue fluid, massive central server, clinical white lighting, cables everywhere',
                lighting_default: 'clinical overhead', time_of_day_default: 'night', atmosphere_notes: 'Sterile meets horror. Blue fluid glow. Mechanical hum.',
                daily_rate: 5000, prep_days: 3, shoot_days: 2, permits_cost: 0, location_type: 'studio'
            }
        ];

        for (const l of locData) {
            const lid = generateId();
            locs[l.name] = lid;
            db.prepare(`
                INSERT INTO film_locations (id, project_id, name, description, reference_prompt,
                    lighting_default, time_of_day_default, atmosphere_notes,
                    daily_rate, prep_days, shoot_days, permits_cost, location_type, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(lid, projectId, l.name, l.description, l.reference_prompt,
                l.lighting_default, l.time_of_day_default, l.atmosphere_notes,
                l.daily_rate, l.prep_days, l.shoot_days, l.permits_cost, l.location_type, now, now);
        }

        // ── Props ────────────────────────────────────────────────
        const propData = [
            { name: 'Service Revolver', description: 'Kai\'s sidearm. Matte black futuristic pistol with biometric grip.', visual_prompt: 'futuristic matte black pistol, biometric grip, holster', category: 'weapon' },
            { name: 'Holographic Display', description: 'Desk-mounted holo projector showing case files and city maps.', visual_prompt: 'holographic display floating blue data, desk mounted, sci-fi office', category: 'technology' },
            { name: 'Data Chip', description: 'Small translucent chip with circuit patterns. Contains the bridge protocol.', visual_prompt: 'small translucent data chip, glowing circuit patterns, held between fingers', category: 'technology' },
            { name: 'Cipher\'s Neon Jacket', description: 'Black jacket with embedded fiber optic LED strips that glow green and blue.', visual_prompt: 'cyberpunk jacket with LED fiber optics, neon green and blue glow', category: 'clothing-accessory' },
            { name: 'Whiskey Glass', description: 'Half-empty whiskey glass on Kai\'s cluttered desk.', visual_prompt: 'half empty whiskey glass, amber liquid, noir desk setting', category: 'generic' },
            { name: 'Neural Implant', description: 'Small device embedded at the base of skull. Glows when active. Can be "fried" or used for consciousness upload.', visual_prompt: 'small neural implant device, base of skull, faint glow, sci-fi medical', category: 'technology' },
            { name: 'Portable Server Unit', description: 'Briefcase-sized server containing 300 uploaded minds. Lights pulse with activity.', visual_prompt: 'futuristic portable server, briefcase size, pulsing lights, cables, bridge scene', category: 'technology' },
            { name: 'Silver Lighter', description: 'Kai\'s silver Zippo lighter. Nervous habit — flicks it when thinking.', visual_prompt: 'silver zippo lighter, engraved, detective hands, dim lighting', category: 'generic' },
        ];

        for (const p of propData) {
            db.prepare(`
                INSERT INTO film_props (id, project_id, name, description, visual_prompt, category, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(generateId(), projectId, p.name, p.description, p.visual_prompt, p.category, now);
        }

        // ── Acts ─────────────────────────────────────────────────
        const actData = [
            { number: 1, name: 'Act One — Setup', description: 'Introduction of Kai, the murders, and the Prometheus Protocol conspiracy.' },
            { number: 2, name: 'Act Two — Confrontation', description: 'Kai discovers the scope of Vex\'s operation and the underground lab.' },
            { number: 3, name: 'Act Three — Resolution', description: 'Final showdown on the bridge. Kai finds a third option to save the uploaded minds.' },
        ];

        // Acts are Fountain `#` sections now, not rows. The demo still HAS act
        // structure — it is written into the screenplay above the first scene of
        // each act, which is where a reader finds it and where an export carries
        // it. See migration 076: the table was dropped because the format says
        // this already, with depth.

        // ── Scenes & Shots ───────────────────────────────────────
        const sceneData = [
            {
                number: 1, int_ext: 'INT', location: "Detective's Office", time: 'NIGHT', act: 1,
                description: 'Kai receives a call about the latest neural murder victim — one with his name carved on the implant.',
                characters: ['Kai Nakamura', 'Lt. Torres'],
                shots: [
                    {
                        code: 'SC01-SH01', duration: 8000,
                        card: { shot_type: 'wide', camera_movement: 'slow_push', lighting: 'low key neon', characters: ['Kai Nakamura'], description: 'Establishing shot of Kai\'s office. Rain on windows, neon glow, ceiling fan shadows. Camera slowly pushes in toward Kai at desk.', dialogue: '' }
                    },
                    {
                        code: 'SC01-SH02', duration: 12000,
                        card: { shot_type: 'medium_close_up', camera_movement: 'static', lighting: 'low key warm', characters: ['Kai Nakamura'], description: 'Kai answers phone. Tension builds as Torres delivers the news. Kai\'s expression hardens.', dialogue: 'KAI: Nakamura. ... I\'m on my way.' }
                    }
                ]
            },
            {
                number: 2, int_ext: 'EXT', location: 'Neon Alley', time: 'NIGHT', act: 1,
                description: 'Kai arrives at the crime scene and meets mysterious informant Cipher.',
                characters: ['Kai Nakamura', 'Cipher'],
                shots: [
                    {
                        code: 'SC02-SH01', duration: 6000,
                        card: { shot_type: 'wide', camera_movement: 'tracking', lighting: 'neon mixed rain', characters: ['Kai Nakamura'], description: 'Kai walks through crime scene tape into the rain-soaked alley. Holographic ads shimmer. Police drones hover.', dialogue: '' }
                    },
                    {
                        code: 'SC02-SH02', duration: 15000,
                        card: { shot_type: 'over_shoulder', camera_movement: 'static', lighting: 'neon green accent', characters: ['Kai Nakamura', 'Cipher'], description: 'Cipher emerges from shadows. Tense exchange about the Prometheus Protocol. Cipher drops a data chip and vanishes.', dialogue: 'CIPHER: It\'s called the Prometheus Protocol. They\'re uploading minds.' }
                    }
                ]
            },
            {
                number: 3, int_ext: 'INT', location: 'Chrome Lounge', time: 'NIGHT', act: 1,
                description: 'Kai confronts Vex in his upscale nightclub. Vex reveals the consciousness upload scheme.',
                characters: ['Kai Nakamura', 'Vex'],
                shots: [
                    {
                        code: 'SC03-SH01', duration: 5000,
                        card: { shot_type: 'wide', camera_movement: 'crane_down', lighting: 'electric blue neon', characters: ['Kai Nakamura'], description: 'Establishing shot of Chrome Lounge interior. Camera cranes down from ceiling to reveal Kai entering. Chrome surfaces, holographic art.', dialogue: '' }
                    },
                    {
                        code: 'SC03-SH02', duration: 18000,
                        card: { shot_type: 'two_shot', camera_movement: 'slow_dolly', lighting: 'blue key light', characters: ['Kai Nakamura', 'Vex'], description: 'Kai sits across from Vex in the VIP booth. Verbal sparring. Vex calmly reveals the consciousness upload program. Slow dolly emphasizes power dynamic.', dialogue: 'VEX: What if death is just a transition? ... It was an invitation.' }
                    }
                ]
            },
            {
                number: 4, int_ext: 'EXT', location: 'Rooftop', time: 'NIGHT', act: 2,
                description: 'Kai chases a suspect across rain-slicked rooftops. Discovers Vex can puppeteer bodies remotely.',
                characters: ['Kai Nakamura', 'Vex'],
                shots: [
                    {
                        code: 'SC04-SH01', duration: 10000,
                        card: { shot_type: 'wide', camera_movement: 'tracking_fast', lighting: 'neon city below', characters: ['Kai Nakamura'], description: 'High-energy chase across rooftops. Kai pursues a hooded figure. Rain-slicked surfaces. Neon city sprawls below. Fast tracking camera.', dialogue: '' }
                    },
                    {
                        code: 'SC04-SH02', duration: 8000,
                        card: { shot_type: 'close_up', camera_movement: 'handheld', lighting: 'red implant glow', characters: ['Kai Nakamura'], description: 'The hooded woman turns — eyes blank, implant glowing red. Speaks in Vex\'s voice. Then collapses. Kai catches her. Handheld intimacy.', dialogue: 'VEX (through woman): The body is just hardware. The mind is the software.' }
                    }
                ]
            },
            {
                number: 5, int_ext: 'INT', location: 'Underground Lab', time: 'NIGHT', act: 2,
                description: 'Cipher leads Kai to the underground lab. They discover 300 people in suspension pods.',
                characters: ['Kai Nakamura', 'Cipher'],
                shots: [
                    {
                        code: 'SC05-SH01', duration: 10000,
                        card: { shot_type: 'wide', camera_movement: 'reveal_dolly', lighting: 'clinical blue', characters: ['Kai Nakamura', 'Cipher'], description: 'Dolly reveal of the underground lab. Rows of suspension pods stretching into darkness. Blue fluid glow. Central server hums. Massive scale.', dialogue: '' }
                    },
                    {
                        code: 'SC05-SH02', duration: 12000,
                        card: { shot_type: 'medium', camera_movement: 'slow_push', lighting: 'blue pod glow', characters: ['Kai Nakamura', 'Cipher'], description: 'Kai and Cipher discuss the horrifying reality. Push in on Kai\'s face as he realizes the scope. A woman in a pod opens blank eyes.', dialogue: 'CIPHER: Three hundred and counting. Pull the plug and they\'re erased.' }
                    }
                ]
            },
            {
                number: 6, int_ext: 'EXT', location: 'Bridge', time: 'DAWN', act: 3,
                description: 'Final confrontation. Kai faces Vex on a bridge at dawn with 300 lives hanging in the balance.',
                characters: ['Kai Nakamura', 'Vex'],
                shots: [
                    {
                        code: 'SC06-SH01', duration: 8000,
                        card: { shot_type: 'extreme_wide', camera_movement: 'crane_up', lighting: 'dawn golden hour', characters: ['Kai Nakamura', 'Vex'], description: 'Dawn breaks through storm clouds. Extreme wide of the suspension bridge. Kai at one end, Vex at the other. Portable server between them. Crane up for scale.', dialogue: '' }
                    },
                    {
                        code: 'SC06-SH02', duration: 20000,
                        card: { shot_type: 'medium', camera_movement: 'steadicam_orbit', lighting: 'dawn warm vs neon cool', characters: ['Kai Nakamura', 'Vex'], description: 'The negotiation. Steadicam orbits between Kai and Vex. Vex offers an ultimatum. Kai reveals the third option — the bridge protocol. Vex panics and jumps.', dialogue: 'KAI: There\'s a third option. ... Cipher already started the transfer. It\'s over.' }
                    }
                ]
            },
            {
                number: 7, int_ext: 'INT', location: "Detective's Office", time: 'DAWN', act: 3,
                description: 'Resolution. Kai back at his desk. Case closed but sequel teased — there are more operations.',
                characters: ['Kai Nakamura'],
                shots: [
                    {
                        code: 'SC07-SH01', duration: 6000,
                        card: { shot_type: 'wide', camera_movement: 'slow_pull', lighting: 'golden dawn', characters: ['Kai Nakamura'], description: 'Same office, now bathed in golden dawn light instead of neon. Camera slowly pulls back. Holo display shows case closed.', dialogue: '' }
                    },
                    {
                        code: 'SC07-SH02', duration: 10000,
                        card: { shot_type: 'extreme_close_up', camera_movement: 'static', lighting: 'warm dawn', characters: ['Kai Nakamura'], description: 'Extreme close-up of the data chip. Kai turns it over — etched on the back: "V2.0 — There are more." Kai\'s face. Fade out.', dialogue: 'KAI: Of course there are.' }
                    }
                ]
            }
        ];

        for (const sc of sceneData) {
            const sceneId = generateId();
            db.prepare(`
                INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day,
                    description, characters_present, estimated_duration, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                sceneId, projectId, sc.number, sc.int_ext, sc.location, sc.time,
                sc.description, JSON.stringify(sc.characters),
                sc.shots.reduce((sum, s) => sum + s.duration, 0),
                'written', now
            );

            for (const shot of sc.shots) {
                db.prepare(`
                    INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, status, duration_ms, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    generateId(), sceneId, shot.code,
                    JSON.stringify(shot.card),
                    'pending', shot.duration, now
                );
            }
        }

        // ── Milestones ───────────────────────────────────────────
        const milestoneData = [
            { title: 'Script Lock', phase: 'script', order: 1, target: '2026-02-15', status: 'completed', pct: 100 },
            { title: 'Storyboard Complete', phase: 'storyboard', order: 2, target: '2026-03-01', status: 'in_progress', pct: 40 },
            { title: 'Principal Photography Start', phase: 'production', order: 3, target: '2026-04-01', status: 'pending', pct: 0 },
            { title: 'Rough Cut', phase: 'post-production', order: 4, target: '2026-06-01', status: 'pending', pct: 0 },
            { title: 'Final Delivery', phase: 'complete', order: 5, target: '2026-08-01', status: 'pending', pct: 0 },
        ];

        for (const m of milestoneData) {
            db.prepare(`
                INSERT INTO film_milestones (id, project_id, title, phase, sort_order, target_date, status, completion_pct, auto_generated, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(generateId(), projectId, m.title, m.phase, m.order, m.target, m.status, m.pct, 0, now, now);
        }

        // ── Budget Estimate ──────────────────────────────────────
        const estimateId = generateId();
        const lineItems = [
            { category: 'above_the_line', subcategory: 'story_rights', description: 'Original screenplay', amount: 25000, source: 'manual', confidence: 'high' },
            { category: 'above_the_line', subcategory: 'director', description: 'Director fee + prep', amount: 75000, source: 'manual', confidence: 'high' },
            { category: 'above_the_line', subcategory: 'producer', description: 'Producer fee', amount: 50000, source: 'manual', confidence: 'high' },
            { category: 'above_the_line', subcategory: 'cast_principal', description: 'Kai Nakamura — Lead (18 days)', amount: 270000, quantity: 18, rate: 15000, source: 'calculated', confidence: 'high' },
            { category: 'above_the_line', subcategory: 'cast_supporting', description: 'Vex — Supporting (10 days)', amount: 80000, quantity: 10, rate: 8000, source: 'calculated', confidence: 'high' },
            { category: 'above_the_line', subcategory: 'cast_day_players', description: 'Cipher (5 days) + Lt. Torres (3 days)', amount: 16000, source: 'calculated', confidence: 'high' },
            { category: 'below_the_line_production', subcategory: 'camera_dept', description: 'DP + operators + ACs (20 days)', amount: 60000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'below_the_line_production', subcategory: 'locations', description: 'Location fees + permits', amount: 42500, source: 'calculated', confidence: 'high' },
            { category: 'below_the_line_production', subcategory: 'art_dept', description: 'Production designer + set dressing — cyberpunk aesthetic', amount: 80000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'below_the_line_production', subcategory: 'equipment_rental', description: 'Camera, lighting, grip (20 days)', amount: 45000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'below_the_line_production', subcategory: 'catering', description: 'Cast + crew meals (20 days, 40 people)', amount: 24000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'post_production', subcategory: 'vfx', description: 'Holographics, neural implants, neon environments, consciousness effects', amount: 150000, source: 'ai_estimate', confidence: 'low' },
            { category: 'post_production', subcategory: 'editing', description: 'Editor + assistant (8 weeks)', amount: 40000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'post_production', subcategory: 'sound_design', description: 'Sound edit, Foley, cyberpunk ambiance', amount: 25000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'post_production', subcategory: 'music_score', description: 'Original synth-noir score', amount: 35000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'post_production', subcategory: 'color_grade', description: 'DI + colorist — neon noir look', amount: 20000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'other', subcategory: 'insurance', description: 'E&O + production insurance', amount: 30000, source: 'ai_estimate', confidence: 'medium' },
            { category: 'other', subcategory: 'contingency', description: '10% contingency', amount: 106750, source: 'calculated', confidence: 'high' },
        ];

        const aboveLine = lineItems.filter(i => i.category === 'above_the_line').reduce((s, i) => s + i.amount, 0);
        const belowLine = lineItems.filter(i => i.category === 'below_the_line_production').reduce((s, i) => s + i.amount, 0);
        const postProd = lineItems.filter(i => i.category === 'post_production').reduce((s, i) => s + i.amount, 0);
        const other = lineItems.filter(i => i.category === 'other').reduce((s, i) => s + i.amount, 0);
        const total = aboveLine + belowLine + postProd + other;

        db.prepare(`
            INSERT INTO film_budget_estimates (id, project_id, name, template, currency,
                total_estimated, above_the_line, below_the_line, production, post_production, other_costs,
                contingency_pct, line_items, assumptions, shooting_days_estimate, complexity_score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            estimateId, projectId, 'Neon Requiem Budget', 'indie', 'USD',
            total, aboveLine, belowLine, belowLine, postProd, other,
            10, JSON.stringify(lineItems),
            JSON.stringify([
                'Non-union indie production',
                'Los Angeles-based shoot',
                '20 shooting days estimated',
                'Significant VFX budget for cyberpunk elements',
                'Original score — synth-noir genre'
            ]),
            20, 7.5, now, now
        );

        // Insert line items into the separate table too
        lineItems.forEach((item, idx) => {
            db.prepare(`
                INSERT INTO film_budget_line_items (id, estimate_id, category, subcategory, description,
                    amount, quantity, rate, unit, source, confidence, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                generateId(), estimateId, item.category, item.subcategory, item.description,
                item.amount, item.quantity || 1, item.rate || item.amount, item.rate ? 'day' : 'flat',
                item.source, item.confidence, idx, now, now
            );
        });

        return {
            project_id: projectId,
            title: 'Neon Requiem',
            scenes: sceneData.length,
            shots: sceneData.reduce((s, sc) => s + sc.shots.length, 0),
            characters: charData.length,
            locations: locData.length,
            props: propData.length,
            acts: actData.length,
            milestones: milestoneData.length,
            budget_total: total
        };
    });

    return seed();
}

module.exports = { handleDemoProject };
