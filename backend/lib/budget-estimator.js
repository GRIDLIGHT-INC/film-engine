/**
 * Budget Estimation Library
 * Analyzes project data to estimate production costs
 */

// Industry standard budget categories (AICP-style top sheet)
const BUDGET_CATEGORIES = {
    above_the_line: [
        { key: 'story_rights', label: 'Story Rights / Script', description: 'Script purchase, options, underlying rights' },
        { key: 'writer', label: 'Writer', description: 'Screenwriter fees, rewrites' },
        { key: 'producer', label: 'Producer', description: 'Producer fees, executive producer' },
        { key: 'director', label: 'Director', description: 'Director fee, prep, post supervision' },
        { key: 'cast_principal', label: 'Principal Cast', description: 'Lead actors' },
        { key: 'cast_supporting', label: 'Supporting Cast', description: 'Supporting actors' },
        { key: 'cast_day_players', label: 'Day Players', description: 'Day player actors' },
        { key: 'cast_extras', label: 'Extras / Background', description: 'Background actors, stand-ins' }
    ],
    below_the_line_production: [
        { key: 'production_staff', label: 'Production Staff', description: 'UPM, ADs, coordinators, PAs' },
        { key: 'camera_dept', label: 'Camera Department', description: 'DP, operators, ACs, DITs' },
        { key: 'sound_dept', label: 'Sound Department', description: 'Mixer, boom operator, utility' },
        { key: 'art_dept', label: 'Art Department', description: 'Production designer, art director, set dec' },
        { key: 'set_construction', label: 'Set Construction', description: 'Set building, materials, labor' },
        { key: 'props', label: 'Props', description: 'Prop purchase, rental, fabrication' },
        { key: 'wardrobe', label: 'Wardrobe', description: 'Costumes, stylists, alterations' },
        { key: 'hair_makeup', label: 'Hair & Makeup', description: 'HMU artists, prosthetics, supplies' },
        { key: 'electrical', label: 'Electrical / Lighting', description: 'Gaffer, best boy, fixtures, gels' },
        { key: 'grip', label: 'Grip', description: 'Key grip, dolly grip, rigging, expendables' },
        { key: 'transportation', label: 'Transportation', description: 'Vehicles, drivers, fuel, parking' },
        { key: 'locations', label: 'Locations', description: 'Permits, fees, security, site prep' },
        { key: 'catering', label: 'Catering / Craft Services', description: 'Meals, craft services, beverages' },
        { key: 'equipment_rental', label: 'Equipment Rental', description: 'Camera, lighting, grip gear rental' },
        { key: 'studio_stage', label: 'Studio / Stage', description: 'Stage rental, facilities, power' }
    ],
    post_production: [
        { key: 'editing', label: 'Editing', description: 'Editor, assistant editor, Avid rental' },
        { key: 'vfx', label: 'Visual Effects', description: 'VFX supervision, compositing, CGI' },
        { key: 'color_grade', label: 'Color Grading', description: 'DI, colorist, conform' },
        { key: 'sound_design', label: 'Sound Design', description: 'Sound editing, Foley, ADR' },
        { key: 'sound_mix', label: 'Sound Mix', description: 'Re-recording mix, dubbing stage' },
        { key: 'music_score', label: 'Music / Score', description: 'Composer, musicians, recording' },
        { key: 'music_licensing', label: 'Music Licensing', description: 'Sync licenses, master licenses' },
        { key: 'deliverables', label: 'Deliverables', description: 'DCP, masters, QC, closed captions' }
    ],
    other: [
        { key: 'insurance', label: 'Insurance', description: 'E&O, production insurance, liability' },
        { key: 'legal', label: 'Legal', description: 'Attorney, contracts, clearances' },
        { key: 'accounting', label: 'Accounting', description: 'Payroll, production accounting, audit' },
        { key: 'marketing', label: 'Marketing', description: 'Trailer, poster, press kit, campaign' },
        { key: 'contingency', label: 'Contingency', description: 'Buffer for overages (typically 10%)' }
    ]
};

// Talent tier rate ranges (USD per day unless noted)
const TALENT_TIER_RATES = {
    background: { min: 150, max: 300, label: 'Background / Extra', unit: 'day' },
    day_player: { min: 1000, max: 3000, label: 'Day Player', unit: 'day' },
    supporting: { min: 5000, max: 25000, label: 'Supporting', unit: 'week' },
    lead: { min: 25000, max: 100000, label: 'Lead', unit: 'project' },
    star: { min: 100000, max: 500000, label: 'Star', unit: 'project' },
    a_list: { min: 500000, max: 20000000, label: 'A-List', unit: 'project' },
    unknown: { min: 1000, max: 10000, label: 'Unknown', unit: 'day' }
};

// Location type rate ranges (USD per day)
const LOCATION_TYPE_RATES = {
    practical: { min: 500, max: 5000, label: 'Practical Location' },
    studio: { min: 2000, max: 25000, label: 'Studio / Stage' },
    backlot: { min: 1000, max: 10000, label: 'Backlot' },
    remote: { min: 3000, max: 15000, label: 'Remote Location' },
    international: { min: 5000, max: 50000, label: 'International' },
    unknown: { min: 1000, max: 5000, label: 'Unknown' }
};

// Budget templates with multipliers and assumptions
const BUDGET_TEMPLATES = {
    micro: {
        label: 'Micro Budget',
        range: { min: 0, max: 100000 },
        assumptions: [
            'Non-union / deferred pay cast',
            'Minimal crew (5-10 people)',
            'Practical locations only',
            'Natural lighting preferred',
            'Limited post-production'
        ],
        multipliers: {
            cast_principal: 0.1,
            cast_supporting: 0.05,
            production_staff: 0.3,
            equipment_rental: 0.5,
            post_production: 0.3
        }
    },
    indie: {
        label: 'Indie Budget',
        range: { min: 100000, max: 1000000 },
        assumptions: [
            'SAG Ultra Low Budget or Modified Low',
            'Small professional crew (15-25)',
            'Mix of practical and rented locations',
            'Basic lighting package',
            'Standard post-production'
        ],
        multipliers: {
            cast_principal: 0.3,
            cast_supporting: 0.2,
            production_staff: 0.6,
            equipment_rental: 0.7,
            post_production: 0.5
        }
    },
    low: {
        label: 'Low Budget',
        range: { min: 1000000, max: 5000000 },
        assumptions: [
            'SAG Low Budget Agreement',
            'Full professional crew (30-50)',
            'Dedicated locations department',
            'Full lighting and grip package',
            'Professional post pipeline'
        ],
        multipliers: {
            cast_principal: 0.5,
            cast_supporting: 0.4,
            production_staff: 0.8,
            equipment_rental: 0.8,
            post_production: 0.7
        }
    },
    mid: {
        label: 'Mid Budget',
        range: { min: 5000000, max: 20000000 },
        assumptions: [
            'SAG Theatrical Agreement',
            'Large crew (50-100)',
            'Significant set construction',
            'Premium equipment packages',
            'Full VFX pipeline'
        ],
        multipliers: {
            cast_principal: 0.8,
            cast_supporting: 0.6,
            production_staff: 1.0,
            equipment_rental: 1.0,
            post_production: 0.9
        }
    },
    studio: {
        label: 'Studio Budget',
        range: { min: 20000000, max: null },
        assumptions: [
            'Full SAG rates and residuals',
            'Very large crew (100+)',
            'Major set pieces and construction',
            'Premium everything',
            'Extensive VFX and post'
        ],
        multipliers: {
            cast_principal: 1.0,
            cast_supporting: 0.8,
            production_staff: 1.0,
            equipment_rental: 1.0,
            post_production: 1.0
        }
    },
    custom: {
        label: 'Custom',
        range: { min: 0, max: null },
        assumptions: [],
        multipliers: {}
    }
};

/**
 * Analyze a project and extract cost factors
 * @param {Object} db - Database connection
 * @param {string} projectId - Project UUID
 * @returns {Object} Analysis results with characters, locations, scenes, shots, missingData
 */
function analyzeProject(db, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;

    // Get all characters with scene counts
    const characters = db.prepare(`
        SELECT c.*,
            (SELECT COUNT(DISTINCT sc.scene_id) FROM film_scene_characters sc WHERE sc.character_id = c.id) AS scene_count,
            (SELECT COUNT(*) FROM film_shots s
             JOIN film_scenes sc ON s.scene_id = sc.id
             WHERE sc.project_id = c.project_id
             AND s.scene_card_yaml LIKE '%' || c.name || '%') AS shot_mentions
        FROM film_characters c
        WHERE c.project_id = ?
        ORDER BY scene_count DESC
    `).all(projectId);

    // Get all locations with scene counts
    const locations = db.prepare(`
        SELECT l.*,
            (SELECT COUNT(*) FROM film_scenes s WHERE s.project_id = l.project_id AND s.location = l.name) AS scene_count
        FROM film_locations l
        WHERE l.project_id = ?
        ORDER BY scene_count DESC
    `).all(projectId);

    // Get all scenes
    const scenes = db.prepare(`
        SELECT s.*,
            (SELECT COUNT(*) FROM film_shots sh WHERE sh.scene_id = s.id) AS shot_count,
            (SELECT COALESCE(SUM(sh.duration_ms), 0) FROM film_shots sh WHERE sh.scene_id = s.id) AS total_duration_ms
        FROM film_scenes s
        WHERE s.project_id = ?
        ORDER BY s.scene_number
    `).all(projectId);

    // Get all shots with VFX detection
    const shots = db.prepare('SELECT * FROM film_shots WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)').all(projectId);

    // Analyze shots for complexity
    let vfxShotCount = 0;
    let totalDurationMs = 0;
    for (const shot of shots) {
        totalDurationMs += shot.duration_ms || 0;
        try {
            const card = JSON.parse(shot.scene_card_yaml || '{}');
            if (card.vfx || card.visual_effects || (card.description && /vfx|cgi|green\s*screen|composite/i.test(card.description))) {
                vfxShotCount++;
            }
        } catch (e) { /* ignore parse errors */ }
    }

    // Estimate shooting days (rough: 3-5 pages/day for indie, 1-2 for studio)
    // Assume ~1 minute per page, so total_duration / 60000 = pages
    const estimatedPages = totalDurationMs / 60000;
    const shootingDaysEstimate = Math.max(1, Math.ceil(estimatedPages / 3)); // Conservative 3 pages/day

    // Detect complexity factors
    const uniqueLocations = new Set(scenes.map(s => s.location).filter(Boolean)).size;
    const nightScenes = scenes.filter(s => /night|evening|dusk/i.test(s.time_of_day || '')).length;
    const exteriorScenes = scenes.filter(s => s.int_ext === 'EXT').length;

    // Calculate complexity score (0-100)
    const complexityScore = Math.min(100,
        (characters.length * 2) +
        (uniqueLocations * 5) +
        (nightScenes * 3) +
        (exteriorScenes * 2) +
        (vfxShotCount * 10) +
        (estimatedPages > 100 ? 20 : estimatedPages > 60 ? 10 : 0)
    );

    // Identify missing data
    const missingData = [];

    // Check characters for missing cost data
    for (const char of characters) {
        if (char.scene_count > 0 && !char.day_rate) {
            const tier = char.talent_tier || 'unknown';
            missingData.push({
                field: 'day_rate',
                entity_type: 'character',
                entity_id: char.id,
                entity_name: char.name,
                tier: tier,
                suggested_range: TALENT_TIER_RATES[tier] || TALENT_TIER_RATES.unknown,
                scene_count: char.scene_count
            });
        }
    }

    // Check locations for missing cost data
    for (const loc of locations) {
        if (loc.scene_count > 0 && !loc.daily_rate) {
            const type = loc.location_type || 'unknown';
            missingData.push({
                field: 'daily_rate',
                entity_type: 'location',
                entity_id: loc.id,
                entity_name: loc.name,
                location_type: type,
                suggested_range: LOCATION_TYPE_RATES[type] || LOCATION_TYPE_RATES.unknown,
                scene_count: loc.scene_count
            });
        }
    }

    return {
        project,
        characters,
        locations,
        scenes,
        shots,
        stats: {
            character_count: characters.length,
            location_count: locations.length,
            scene_count: scenes.length,
            shot_count: shots.length,
            vfx_shot_count: vfxShotCount,
            total_duration_ms: totalDurationMs,
            estimated_pages: Math.round(estimatedPages * 10) / 10,
            shooting_days_estimate: shootingDaysEstimate,
            unique_locations: uniqueLocations,
            night_scenes: nightScenes,
            exterior_scenes: exteriorScenes,
            complexity_score: Math.round(complexityScore)
        },
        missingData
    };
}

/**
 * Estimate character cost
 * @param {Object} character - Character record
 * @param {number} shootingDays - Estimated shooting days for the character
 * @returns {Object} Cost estimate
 */
function estimateCharacterCost(character, shootingDays) {
    if (character.day_rate && character.shooting_days) {
        return {
            amount: character.day_rate * character.shooting_days + (character.travel_allowance || 0),
            source: 'manual',
            confidence: 'high',
            breakdown: {
                day_rate: character.day_rate,
                days: character.shooting_days,
                travel: character.travel_allowance || 0
            }
        };
    }

    const tier = character.talent_tier || 'unknown';
    const rates = TALENT_TIER_RATES[tier] || TALENT_TIER_RATES.unknown;
    const midpoint = (rates.min + rates.max) / 2;
    const days = character.shooting_days || shootingDays || 1;

    let amount;
    if (rates.unit === 'project') {
        amount = midpoint;
    } else if (rates.unit === 'week') {
        amount = midpoint * Math.ceil(days / 5);
    } else {
        amount = midpoint * days;
    }

    return {
        amount: Math.round(amount),
        source: 'estimated',
        confidence: 'low',
        needsInput: true,
        suggested_range: rates,
        breakdown: {
            estimated_rate: midpoint,
            days: days,
            tier: tier
        }
    };
}

/**
 * Estimate location cost
 * @param {Object} location - Location record
 * @param {number} shootDays - Number of shoot days at this location
 * @returns {Object} Cost estimate
 */
function estimateLocationCost(location, shootDays) {
    if (location.daily_rate) {
        const prepDays = location.prep_days || 0;
        const days = location.shoot_days || shootDays || 1;
        const prepCost = prepDays * (location.daily_rate * 0.5); // Prep usually half rate
        const shootCost = days * location.daily_rate;
        const permits = location.permits_cost || 0;

        return {
            amount: prepCost + shootCost + permits,
            source: 'manual',
            confidence: 'high',
            breakdown: {
                daily_rate: location.daily_rate,
                prep_days: prepDays,
                shoot_days: days,
                prep_cost: prepCost,
                shoot_cost: shootCost,
                permits: permits
            }
        };
    }

    const type = location.location_type || 'unknown';
    const rates = LOCATION_TYPE_RATES[type] || LOCATION_TYPE_RATES.unknown;
    const midpoint = (rates.min + rates.max) / 2;
    const days = shootDays || 1;

    return {
        amount: Math.round(midpoint * days),
        source: 'estimated',
        confidence: 'low',
        needsInput: true,
        suggested_range: rates,
        breakdown: {
            estimated_rate: midpoint,
            days: days,
            type: type
        }
    };
}

/**
 * Generate a full budget estimate
 * @param {Object} db - Database connection
 * @param {string} projectId - Project UUID
 * @param {Object} options - Options (template, includeEstimates)
 * @returns {Object} Full budget estimate
 */
function generateEstimate(db, projectId, options = {}) {
    const analysis = analyzeProject(db, projectId);
    if (!analysis) return null;

    const template = options.template || 'custom';
    const templateConfig = BUDGET_TEMPLATES[template] || BUDGET_TEMPLATES.custom;
    const includeEstimates = options.includeEstimates !== false;

    const lineItems = [];
    const assumptions = [...templateConfig.assumptions];
    const missingData = [];

    let aboveTheLine = 0;
    let belowTheLine = 0;
    let postProduction = 0;
    let otherCosts = 0;

    // === ABOVE THE LINE ===

    // Cast - Principal (leads)
    const leads = analysis.characters.filter(c =>
        (c.talent_tier === 'lead' || c.talent_tier === 'star' || c.talent_tier === 'a_list') ||
        (c.scene_count >= 5 && !c.talent_tier)
    );

    for (const char of leads) {
        const estimate = estimateCharacterCost(char, Math.ceil(analysis.stats.shooting_days_estimate * 0.8));
        lineItems.push({
            category: 'above_the_line',
            subcategory: 'cast_principal',
            description: `${char.name}${char.actor_name ? ` (${char.actor_name})` : ''}`,
            amount: estimate.amount,
            source: estimate.source,
            confidence: estimate.confidence,
            entity_type: 'character',
            entity_id: char.id
        });
        aboveTheLine += estimate.amount;
        if (estimate.needsInput) {
            missingData.push({
                field: 'day_rate',
                entity_type: 'character',
                entity_id: char.id,
                entity_name: char.name,
                suggested_range: estimate.suggested_range
            });
        }
    }

    // Cast - Supporting
    const supporting = analysis.characters.filter(c =>
        (c.talent_tier === 'supporting' || c.talent_tier === 'day_player') ||
        (c.scene_count >= 2 && c.scene_count < 5 && !c.talent_tier)
    );

    for (const char of supporting) {
        const estimate = estimateCharacterCost(char, Math.ceil(analysis.stats.shooting_days_estimate * 0.3));
        lineItems.push({
            category: 'above_the_line',
            subcategory: 'cast_supporting',
            description: `${char.name}${char.actor_name ? ` (${char.actor_name})` : ''}`,
            amount: estimate.amount,
            source: estimate.source,
            confidence: estimate.confidence,
            entity_type: 'character',
            entity_id: char.id
        });
        aboveTheLine += estimate.amount;
        if (estimate.needsInput) {
            missingData.push({
                field: 'day_rate',
                entity_type: 'character',
                entity_id: char.id,
                entity_name: char.name,
                suggested_range: estimate.suggested_range
            });
        }
    }

    // === BELOW THE LINE - PRODUCTION ===

    // Locations
    for (const loc of analysis.locations) {
        if (loc.scene_count > 0) {
            const shootDays = Math.ceil(loc.scene_count * analysis.stats.shooting_days_estimate / analysis.stats.scene_count) || 1;
            const estimate = estimateLocationCost(loc, shootDays);
            lineItems.push({
                category: 'below_the_line_production',
                subcategory: 'locations',
                description: loc.name,
                amount: estimate.amount,
                source: estimate.source,
                confidence: estimate.confidence,
                entity_type: 'location',
                entity_id: loc.id
            });
            belowTheLine += estimate.amount;
            if (estimate.needsInput) {
                missingData.push({
                    field: 'daily_rate',
                    entity_type: 'location',
                    entity_id: loc.id,
                    entity_name: loc.name,
                    suggested_range: estimate.suggested_range
                });
            }
        }
    }

    // Equipment rental estimate based on shooting days and complexity
    if (includeEstimates) {
        const equipmentBase = analysis.stats.complexity_score > 50 ? 5000 : 2500;
        const equipmentEstimate = equipmentBase * analysis.stats.shooting_days_estimate;
        lineItems.push({
            category: 'below_the_line_production',
            subcategory: 'equipment_rental',
            description: 'Camera, lighting, grip package',
            amount: equipmentEstimate,
            quantity: analysis.stats.shooting_days_estimate,
            rate: equipmentBase,
            unit: 'day',
            source: 'estimated',
            confidence: 'low'
        });
        belowTheLine += equipmentEstimate;
        assumptions.push(`Equipment rental estimated at $${equipmentBase}/day based on complexity score`);
    }

    // Catering estimate
    if (includeEstimates) {
        const crewSize = analysis.stats.complexity_score > 50 ? 30 : 15;
        const mealCost = 35; // Per person per day
        const cateringEstimate = crewSize * mealCost * analysis.stats.shooting_days_estimate;
        lineItems.push({
            category: 'below_the_line_production',
            subcategory: 'catering',
            description: `Catering for ~${crewSize} crew`,
            amount: cateringEstimate,
            quantity: crewSize * analysis.stats.shooting_days_estimate,
            rate: mealCost,
            unit: 'person/day',
            source: 'estimated',
            confidence: 'medium'
        });
        belowTheLine += cateringEstimate;
    }

    // === POST PRODUCTION ===

    if (includeEstimates) {
        // Editing estimate
        const editingWeeks = Math.ceil(analysis.stats.estimated_pages / 15); // ~15 pages per week of editing
        const editorRate = template === 'micro' ? 1500 : template === 'indie' ? 2500 : 4000;
        const editingEstimate = editingWeeks * editorRate;
        lineItems.push({
            category: 'post_production',
            subcategory: 'editing',
            description: 'Editor',
            amount: editingEstimate,
            quantity: editingWeeks,
            rate: editorRate,
            unit: 'week',
            source: 'estimated',
            confidence: 'medium'
        });
        postProduction += editingEstimate;

        // VFX estimate if applicable
        if (analysis.stats.vfx_shot_count > 0) {
            const vfxPerShot = template === 'micro' ? 500 : template === 'indie' ? 1500 : 5000;
            const vfxEstimate = analysis.stats.vfx_shot_count * vfxPerShot;
            lineItems.push({
                category: 'post_production',
                subcategory: 'vfx',
                description: `Visual effects (${analysis.stats.vfx_shot_count} shots)`,
                amount: vfxEstimate,
                quantity: analysis.stats.vfx_shot_count,
                rate: vfxPerShot,
                unit: 'shot',
                source: 'estimated',
                confidence: 'low'
            });
            postProduction += vfxEstimate;
        }

        // Color grading flat rate
        const colorEstimate = template === 'micro' ? 2000 : template === 'indie' ? 5000 : 15000;
        lineItems.push({
            category: 'post_production',
            subcategory: 'color_grade',
            description: 'Color grading / DI',
            amount: colorEstimate,
            source: 'estimated',
            confidence: 'medium'
        });
        postProduction += colorEstimate;

        // Sound design and mix
        const soundEstimate = template === 'micro' ? 3000 : template === 'indie' ? 10000 : 30000;
        lineItems.push({
            category: 'post_production',
            subcategory: 'sound_mix',
            description: 'Sound design, edit, and mix',
            amount: soundEstimate,
            source: 'estimated',
            confidence: 'medium'
        });
        postProduction += soundEstimate;
    }

    // === OTHER ===

    if (includeEstimates) {
        // Insurance estimate (typically 2-3% of budget)
        const subtotal = aboveTheLine + belowTheLine + postProduction;
        const insuranceEstimate = Math.round(subtotal * 0.025);
        lineItems.push({
            category: 'other',
            subcategory: 'insurance',
            description: 'Production insurance, E&O',
            amount: insuranceEstimate,
            source: 'calculated',
            confidence: 'medium'
        });
        otherCosts += insuranceEstimate;
        assumptions.push('Insurance estimated at 2.5% of production budget');
    }

    // Contingency
    const subtotalBeforeContingency = aboveTheLine + belowTheLine + postProduction + otherCosts;
    const contingencyPct = options.contingencyPct || 10;
    const contingencyAmount = Math.round(subtotalBeforeContingency * (contingencyPct / 100));
    lineItems.push({
        category: 'other',
        subcategory: 'contingency',
        description: `${contingencyPct}% contingency`,
        amount: contingencyAmount,
        source: 'calculated',
        confidence: 'high'
    });
    otherCosts += contingencyAmount;

    const totalEstimated = aboveTheLine + belowTheLine + postProduction + otherCosts;

    return {
        project_id: projectId,
        project_title: analysis.project.title,
        template,
        template_label: templateConfig.label,
        currency: 'USD',
        total_estimated: totalEstimated,
        above_the_line: aboveTheLine,
        below_the_line: belowTheLine,
        post_production: postProduction,
        other_costs: otherCosts,
        contingency_pct: contingencyPct,
        line_items: lineItems,
        assumptions,
        missing_data: missingData,
        stats: analysis.stats,
        generated_at: new Date().toISOString()
    };
}

/**
 * Build a web search query for a missing data field
 * @param {Object} item - Missing data item
 * @returns {string} Search query
 */
function buildWebSearchQuery(item) {
    const year = new Date().getFullYear();

    if (item.entity_type === 'character') {
        const tier = item.tier || 'unknown';
        if (tier === 'background' || tier === 'day_player') {
            return `SAG-AFTRA ${tier.replace('_', ' ')} rate ${year}`;
        } else if (tier === 'supporting' || tier === 'lead') {
            return `film actor ${tier} role salary range ${year}`;
        } else if (tier === 'star' || tier === 'a_list') {
            return `A-list movie star salary ${year}`;
        }
        return `film actor day rate ${year}`;
    }

    if (item.entity_type === 'location') {
        const type = item.location_type || 'practical';
        if (type === 'studio') {
            return `film studio stage rental daily rate ${year}`;
        } else if (type === 'international') {
            return `international film location costs ${year}`;
        }
        return `film location rental ${type} daily rate ${year}`;
    }

    return `film production ${item.field} cost ${year}`;
}

/**
 * Get all budget categories with their subcategories
 * @returns {Object} Budget categories
 */
function getBudgetCategories() {
    return BUDGET_CATEGORIES;
}

/**
 * Get all budget templates
 * @returns {Object} Budget templates
 */
function getBudgetTemplates() {
    return Object.entries(BUDGET_TEMPLATES).map(([key, config]) => ({
        key,
        label: config.label,
        range: config.range,
        assumptions: config.assumptions
    }));
}

/**
 * Get talent tier options
 * @returns {Array} Talent tier options
 */
function getTalentTiers() {
    return Object.entries(TALENT_TIER_RATES).map(([key, config]) => ({
        key,
        label: config.label,
        min: config.min,
        max: config.max,
        unit: config.unit
    }));
}

/**
 * Get location type options
 * @returns {Array} Location type options
 */
function getLocationTypes() {
    return Object.entries(LOCATION_TYPE_RATES).map(([key, config]) => ({
        key,
        label: config.label,
        min: config.min,
        max: config.max
    }));
}

module.exports = {
    analyzeProject,
    estimateCharacterCost,
    estimateLocationCost,
    generateEstimate,
    buildWebSearchQuery,
    getBudgetCategories,
    getBudgetTemplates,
    getTalentTiers,
    getLocationTypes,
    BUDGET_CATEGORIES,
    BUDGET_TEMPLATES,
    TALENT_TIER_RATES,
    LOCATION_TYPE_RATES
};
