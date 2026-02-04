/**
 * Budget Estimator Unit Tests
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../lib/budget-estimator');

// Mock database for testing
function createMockDb(data = {}) {
    const projects = data.projects || [];
    const characters = data.characters || [];
    const locations = data.locations || [];
    const scenes = data.scenes || [];
    const shots = data.shots || [];
    const sceneCharacters = data.sceneCharacters || [];

    // Track the current project context for filtering
    let currentProjectId = null;

    return {
        prepare: (sql) => ({
            get: (...args) => {
                if (sql.includes('FROM film_projects')) {
                    currentProjectId = args[0];
                    return projects.find(p => p.id === args[0]);
                }
                return null;
            },
            all: (...args) => {
                if (sql.includes('FROM film_characters')) {
                    currentProjectId = args[0];
                    return characters.filter(c => c.project_id === args[0]).map(c => ({
                        ...c,
                        scene_count: sceneCharacters.filter(sc => sc.character_id === c.id).length,
                        shot_mentions: 0
                    }));
                }
                if (sql.includes('FROM film_locations')) {
                    return locations.filter(l => l.project_id === args[0]).map(l => ({
                        ...l,
                        scene_count: scenes.filter(s => s.project_id === args[0] && s.location === l.name).length
                    }));
                }
                if (sql.includes('FROM film_scenes')) {
                    currentProjectId = args[0];
                    return scenes.filter(s => s.project_id === args[0]).map(s => ({
                        ...s,
                        shot_count: shots.filter(sh => sh.scene_id === s.id).length,
                        total_duration_ms: shots.filter(sh => sh.scene_id === s.id)
                            .reduce((sum, sh) => sum + (sh.duration_ms || 0), 0)
                    }));
                }
                if (sql.includes('FROM film_shots')) {
                    // The SQL is: WHERE scene_id IN (SELECT id FROM film_scenes WHERE project_id = ?)
                    // So args[0] is the projectId
                    const queryProjectId = args[0] || currentProjectId;
                    const projectSceneIds = scenes.filter(s => s.project_id === queryProjectId).map(s => s.id);
                    return shots.filter(sh => projectSceneIds.includes(sh.scene_id));
                }
                return [];
            }
        })
    };
}

describe('budget-estimator', () => {

    describe('BUDGET_CATEGORIES', () => {
        it('should have four main categories', () => {
            assert.ok(BUDGET_CATEGORIES.above_the_line);
            assert.ok(BUDGET_CATEGORIES.below_the_line_production);
            assert.ok(BUDGET_CATEGORIES.post_production);
            assert.ok(BUDGET_CATEGORIES.other);
        });

        it('should have expected above_the_line subcategories', () => {
            const keys = BUDGET_CATEGORIES.above_the_line.map(c => c.key);
            assert.ok(keys.includes('story_rights'));
            assert.ok(keys.includes('director'));
            assert.ok(keys.includes('cast_principal'));
            assert.ok(keys.includes('cast_supporting'));
        });

        it('should have expected below_the_line subcategories', () => {
            const keys = BUDGET_CATEGORIES.below_the_line_production.map(c => c.key);
            assert.ok(keys.includes('camera_dept'));
            assert.ok(keys.includes('locations'));
            assert.ok(keys.includes('equipment_rental'));
            assert.ok(keys.includes('catering'));
        });

        it('should have expected post_production subcategories', () => {
            const keys = BUDGET_CATEGORIES.post_production.map(c => c.key);
            assert.ok(keys.includes('editing'));
            assert.ok(keys.includes('vfx'));
            assert.ok(keys.includes('color_grade'));
            assert.ok(keys.includes('sound_mix'));
        });

        it('should have contingency in other', () => {
            const keys = BUDGET_CATEGORIES.other.map(c => c.key);
            assert.ok(keys.includes('contingency'));
            assert.ok(keys.includes('insurance'));
        });
    });

    describe('TALENT_TIER_RATES', () => {
        it('should have all talent tiers', () => {
            assert.ok(TALENT_TIER_RATES.background);
            assert.ok(TALENT_TIER_RATES.day_player);
            assert.ok(TALENT_TIER_RATES.supporting);
            assert.ok(TALENT_TIER_RATES.lead);
            assert.ok(TALENT_TIER_RATES.star);
            assert.ok(TALENT_TIER_RATES.a_list);
            assert.ok(TALENT_TIER_RATES.unknown);
        });

        it('should have increasing rates by tier', () => {
            assert.ok(TALENT_TIER_RATES.background.max < TALENT_TIER_RATES.day_player.max);
            assert.ok(TALENT_TIER_RATES.day_player.max < TALENT_TIER_RATES.supporting.max);
            assert.ok(TALENT_TIER_RATES.supporting.max < TALENT_TIER_RATES.lead.max);
            assert.ok(TALENT_TIER_RATES.lead.max < TALENT_TIER_RATES.star.max);
            assert.ok(TALENT_TIER_RATES.star.max < TALENT_TIER_RATES.a_list.max);
        });

        it('should have min and max for each tier', () => {
            for (const tier of Object.values(TALENT_TIER_RATES)) {
                assert.ok(typeof tier.min === 'number');
                assert.ok(typeof tier.max === 'number');
                assert.ok(tier.min <= tier.max);
            }
        });
    });

    describe('LOCATION_TYPE_RATES', () => {
        it('should have all location types', () => {
            assert.ok(LOCATION_TYPE_RATES.practical);
            assert.ok(LOCATION_TYPE_RATES.studio);
            assert.ok(LOCATION_TYPE_RATES.backlot);
            assert.ok(LOCATION_TYPE_RATES.remote);
            assert.ok(LOCATION_TYPE_RATES.international);
            assert.ok(LOCATION_TYPE_RATES.unknown);
        });

        it('should have min and max for each type', () => {
            for (const type of Object.values(LOCATION_TYPE_RATES)) {
                assert.ok(typeof type.min === 'number');
                assert.ok(typeof type.max === 'number');
                assert.ok(type.min <= type.max);
            }
        });
    });

    describe('BUDGET_TEMPLATES', () => {
        it('should have all templates', () => {
            assert.ok(BUDGET_TEMPLATES.micro);
            assert.ok(BUDGET_TEMPLATES.indie);
            assert.ok(BUDGET_TEMPLATES.low);
            assert.ok(BUDGET_TEMPLATES.mid);
            assert.ok(BUDGET_TEMPLATES.studio);
            assert.ok(BUDGET_TEMPLATES.custom);
        });

        it('should have label and range for each template', () => {
            for (const [key, template] of Object.entries(BUDGET_TEMPLATES)) {
                assert.ok(typeof template.label === 'string', `${key} should have label`);
                assert.ok(template.range, `${key} should have range`);
            }
        });

        it('should have increasing budget ranges', () => {
            assert.strictEqual(BUDGET_TEMPLATES.micro.range.max, 100000);
            assert.strictEqual(BUDGET_TEMPLATES.indie.range.min, 100000);
            assert.strictEqual(BUDGET_TEMPLATES.indie.range.max, 1000000);
            assert.strictEqual(BUDGET_TEMPLATES.low.range.min, 1000000);
        });
    });

    describe('estimateCharacterCost', () => {
        it('should use manual day_rate if provided', () => {
            const character = {
                day_rate: 5000,
                shooting_days: 10,
                travel_allowance: 500
            };
            const result = estimateCharacterCost(character, 5);
            assert.strictEqual(result.amount, 50500); // 5000 * 10 + 500
            assert.strictEqual(result.source, 'manual');
            assert.strictEqual(result.confidence, 'high');
        });

        it('should estimate based on talent tier if no day_rate', () => {
            const character = {
                talent_tier: 'supporting'
            };
            const result = estimateCharacterCost(character, 5);
            assert.ok(result.amount > 0);
            assert.strictEqual(result.source, 'estimated');
            assert.strictEqual(result.confidence, 'low');
            assert.ok(result.needsInput);
        });

        it('should use unknown tier rates if tier not specified', () => {
            const character = {};
            const result = estimateCharacterCost(character, 5);
            assert.ok(result.amount > 0);
            assert.strictEqual(result.breakdown.tier, 'unknown');
        });

        it('should calculate project-based rates for star tier', () => {
            const character = {
                talent_tier: 'star'
            };
            const result = estimateCharacterCost(character, 10);
            // Star tier is project-based, not day-based
            const starMidpoint = (TALENT_TIER_RATES.star.min + TALENT_TIER_RATES.star.max) / 2;
            assert.strictEqual(result.amount, Math.round(starMidpoint));
        });
    });

    describe('estimateLocationCost', () => {
        it('should use manual daily_rate if provided', () => {
            const location = {
                daily_rate: 2500,
                prep_days: 2,
                shoot_days: 5,
                permits_cost: 1000
            };
            const result = estimateLocationCost(location, 3);
            // prep: 2 * 1250 = 2500, shoot: 5 * 2500 = 12500, permits: 1000 = 16000
            assert.strictEqual(result.amount, 16000);
            assert.strictEqual(result.source, 'manual');
            assert.strictEqual(result.confidence, 'high');
        });

        it('should estimate based on location type if no daily_rate', () => {
            const location = {
                location_type: 'studio'
            };
            const result = estimateLocationCost(location, 5);
            assert.ok(result.amount > 0);
            assert.strictEqual(result.source, 'estimated');
            assert.strictEqual(result.confidence, 'low');
            assert.ok(result.needsInput);
        });

        it('should use unknown type rates if type not specified', () => {
            const location = {};
            const result = estimateLocationCost(location, 5);
            assert.ok(result.amount > 0);
            assert.strictEqual(result.breakdown.type, 'unknown');
        });
    });

    describe('buildWebSearchQuery', () => {
        it('should build SAG query for day_player', () => {
            const item = {
                entity_type: 'character',
                tier: 'day_player'
            };
            const query = buildWebSearchQuery(item);
            assert.ok(query.includes('SAG'));
            assert.ok(query.includes('day player'));
        });

        it('should build studio query for studio location', () => {
            const item = {
                entity_type: 'location',
                location_type: 'studio'
            };
            const query = buildWebSearchQuery(item);
            assert.ok(query.includes('studio'));
            assert.ok(query.includes('rental'));
        });

        it('should include current year in query', () => {
            const item = {
                entity_type: 'character',
                tier: 'supporting'
            };
            const query = buildWebSearchQuery(item);
            const currentYear = new Date().getFullYear();
            assert.ok(query.includes(String(currentYear)));
        });
    });

    describe('getBudgetCategories', () => {
        it('should return all budget categories', () => {
            const categories = getBudgetCategories();
            assert.ok(categories.above_the_line);
            assert.ok(categories.below_the_line_production);
            assert.ok(categories.post_production);
            assert.ok(categories.other);
        });
    });

    describe('getBudgetTemplates', () => {
        it('should return array of templates', () => {
            const templates = getBudgetTemplates();
            assert.ok(Array.isArray(templates));
            assert.ok(templates.length >= 6);
        });

        it('should include key, label, and range for each template', () => {
            const templates = getBudgetTemplates();
            for (const template of templates) {
                assert.ok(template.key);
                assert.ok(template.label);
                assert.ok(template.range);
            }
        });
    });

    describe('getTalentTiers', () => {
        it('should return array of tiers', () => {
            const tiers = getTalentTiers();
            assert.ok(Array.isArray(tiers));
            assert.ok(tiers.length >= 7);
        });

        it('should include key, label, min, max for each tier', () => {
            const tiers = getTalentTiers();
            for (const tier of tiers) {
                assert.ok(tier.key);
                assert.ok(tier.label);
                assert.ok(typeof tier.min === 'number');
                assert.ok(typeof tier.max === 'number');
            }
        });
    });

    describe('getLocationTypes', () => {
        it('should return array of location types', () => {
            const types = getLocationTypes();
            assert.ok(Array.isArray(types));
            assert.ok(types.length >= 6);
        });

        it('should include key, label, min, max for each type', () => {
            const types = getLocationTypes();
            for (const type of types) {
                assert.ok(type.key);
                assert.ok(type.label);
                assert.ok(typeof type.min === 'number');
                assert.ok(typeof type.max === 'number');
            }
        });
    });

    describe('analyzeProject', () => {
        it('should return null for non-existent project', () => {
            const db = createMockDb({});
            const result = analyzeProject(db, 'non-existent-id');
            assert.strictEqual(result, null);
        });

        it('should analyze project with characters and locations', () => {
            const projectId = 'test-project-1';
            const db = createMockDb({
                projects: [{ id: projectId, title: 'Test Movie', genre: 'Drama' }],
                characters: [
                    { id: 'char-1', project_id: projectId, name: 'Hero', talent_tier: 'lead' },
                    { id: 'char-2', project_id: projectId, name: 'Villain', talent_tier: 'supporting' }
                ],
                locations: [
                    { id: 'loc-1', project_id: projectId, name: 'City Street', location_type: 'practical' }
                ],
                scenes: [
                    { id: 'scene-1', project_id: projectId, scene_number: 1, location: 'City Street', int_ext: 'EXT', time_of_day: 'DAY' }
                ],
                shots: [
                    { id: 'shot-1', scene_id: 'scene-1', duration_ms: 5000, scene_card_yaml: '{}' }
                ],
                sceneCharacters: [
                    { scene_id: 'scene-1', character_id: 'char-1' }
                ]
            });

            const result = analyzeProject(db, projectId);
            assert.ok(result);
            assert.strictEqual(result.project.id, projectId);
            assert.strictEqual(result.stats.character_count, 2);
            assert.strictEqual(result.stats.location_count, 1);
            assert.strictEqual(result.stats.scene_count, 1);
            assert.strictEqual(result.stats.shot_count, 1);
        });

        it('should identify missing data for characters without day_rate', () => {
            const projectId = 'test-project-2';
            const db = createMockDb({
                projects: [{ id: projectId, title: 'Test Movie' }],
                characters: [
                    { id: 'char-1', project_id: projectId, name: 'Hero', talent_tier: 'lead' }
                ],
                locations: [],
                scenes: [
                    { id: 'scene-1', project_id: projectId, scene_number: 1 }
                ],
                shots: [],
                sceneCharacters: [
                    { scene_id: 'scene-1', character_id: 'char-1' }
                ]
            });

            const result = analyzeProject(db, projectId);
            assert.ok(result.missingData.length > 0);
            assert.strictEqual(result.missingData[0].entity_type, 'character');
            assert.strictEqual(result.missingData[0].field, 'day_rate');
        });

        it('should calculate complexity score', () => {
            const projectId = 'test-project-3';
            const db = createMockDb({
                projects: [{ id: projectId, title: 'Complex Movie' }],
                characters: [
                    { id: 'c1', project_id: projectId, name: 'A' },
                    { id: 'c2', project_id: projectId, name: 'B' },
                    { id: 'c3', project_id: projectId, name: 'C' }
                ],
                locations: [
                    { id: 'l1', project_id: projectId, name: 'Location 1' },
                    { id: 'l2', project_id: projectId, name: 'Location 2' }
                ],
                scenes: [
                    { id: 's1', project_id: projectId, scene_number: 1, location: 'Location 1', int_ext: 'EXT', time_of_day: 'NIGHT' },
                    { id: 's2', project_id: projectId, scene_number: 2, location: 'Location 2', int_ext: 'INT', time_of_day: 'DAY' }
                ],
                shots: [
                    { id: 'sh1', scene_id: 's1', duration_ms: 60000, scene_card_yaml: '{}' }
                ],
                sceneCharacters: []
            });

            const result = analyzeProject(db, projectId);
            // Complexity score based on: 3 chars * 2 + 2 locations * 5 + 1 night * 3 + 1 exterior * 2 = 21
            assert.ok(result.stats.complexity_score > 0);
            assert.strictEqual(result.stats.night_scenes, 1);
            assert.strictEqual(result.stats.exterior_scenes, 1);
            assert.strictEqual(result.stats.unique_locations, 2);
        });
    });

    describe('generateEstimate', () => {
        it('should generate estimate with line items', () => {
            const projectId = 'test-project-4';
            const db = createMockDb({
                projects: [{ id: projectId, title: 'Budget Test', genre: 'Action' }],
                characters: [
                    { id: 'c1', project_id: projectId, name: 'Hero', talent_tier: 'lead', day_rate: 50000, shooting_days: 20 }
                ],
                locations: [
                    { id: 'l1', project_id: projectId, name: 'Warehouse', location_type: 'practical', daily_rate: 2000 }
                ],
                scenes: [
                    { id: 's1', project_id: projectId, scene_number: 1, location: 'Warehouse' }
                ],
                shots: [
                    { id: 'sh1', scene_id: 's1', duration_ms: 60000, scene_card_yaml: '{}' }
                ],
                sceneCharacters: [
                    { scene_id: 's1', character_id: 'c1' }
                ]
            });

            const result = generateEstimate(db, projectId, { template: 'indie' });
            assert.ok(result);
            assert.ok(result.total_estimated > 0);
            assert.ok(result.line_items.length > 0);
            assert.strictEqual(result.template, 'indie');
            assert.ok(result.above_the_line >= 0);
            assert.ok(result.below_the_line >= 0);
            assert.ok(result.post_production >= 0);
        });

        it('should include contingency', () => {
            const projectId = 'test-project-5';
            const db = createMockDb({
                projects: [{ id: projectId, title: 'Contingency Test' }],
                characters: [],
                locations: [],
                scenes: [],
                shots: [],
                sceneCharacters: []
            });

            const result = generateEstimate(db, projectId, { contingencyPct: 15 });
            assert.ok(result);
            assert.strictEqual(result.contingency_pct, 15);
            const contingencyItem = result.line_items.find(i => i.subcategory === 'contingency');
            assert.ok(contingencyItem);
            assert.ok(contingencyItem.description.includes('15%'));
        });

        it('should identify missing data', () => {
            const projectId = 'test-project-6';
            const db = createMockDb({
                projects: [{ id: projectId, title: 'Missing Data Test' }],
                characters: [
                    { id: 'c1', project_id: projectId, name: 'Hero', talent_tier: 'lead' }
                ],
                locations: [
                    { id: 'l1', project_id: projectId, name: 'Office' }
                ],
                scenes: [
                    { id: 's1', project_id: projectId, scene_number: 1, location: 'Office' }
                ],
                shots: [],
                sceneCharacters: [
                    { scene_id: 's1', character_id: 'c1' }
                ]
            });

            const result = generateEstimate(db, projectId);
            assert.ok(result.missing_data.length > 0);
        });

        it('should return null for non-existent project', () => {
            const db = createMockDb({});
            const result = generateEstimate(db, 'non-existent');
            assert.strictEqual(result, null);
        });
    });

});
