/**
 * Story frameworks, and the holes in a structure.
 *
 * The one thing in either app that answers *where is the structure missing*.
 * Adapting a forty-chapter novel that is exactly the question: which chapters
 * are one scene, which are three, and which beats have nothing yet.
 *
 * **What is NOT linked is the output.** A list of beats you have covered
 * answers the easy half; the useful half is the beat with no scene against it,
 * because that is where the adaptation has a gap and where the next work is.
 *
 * The frameworks are DATA, so a fifth is a literal rather than an edit to any
 * logic — the same reason the node handlers and provider adapters autoload. Each
 * beat carries `at`, the point in the story it usually falls, as a percentage:
 * that is what lets a beat sheet be laid against a script of any length, and it
 * is a convention of the framework rather than a rule about this film.
 *
 * `guidance` is not decoration. A beat called "Midpoint" with no note is a
 * label, and a writer adapting someone else's book needs to know what the beat
 * is FOR before they can decide which chapter is it.
 */

const FRAMEWORKS = {
    'three-act': {
        label: 'Three Act',
        note: 'The default shape. Fewest beats, hardest to argue with.',
        beats: [
            { name: 'Opening image', at: 1, guidance: 'The world as it is, before anything is asked of it.' },
            { name: 'Inciting incident', at: 10, guidance: 'The thing that makes the story necessary. Before this, the character could have gone home.' },
            { name: 'End of Act One', at: 25, guidance: 'The door closes behind them. Going back is now harder than going on.' },
            { name: 'Midpoint', at: 50, guidance: 'What they believed turns out to be wrong, or what they wanted turns out to be the wrong thing.' },
            { name: 'Low point', at: 75, guidance: 'The cost is paid. Whatever they were protecting is lost or looks lost.' },
            { name: 'Climax', at: 90, guidance: 'The question the story asked, answered by an action rather than a speech.' },
            { name: 'Resolution', at: 98, guidance: 'The world as it is now. Rhymes with the opening image and is not the same.' },
        ],
    },
    'save-the-cat': {
        label: 'Save the Cat',
        note: 'Fifteen beats with tight percentages. The most prescriptive, and the most useful when a draft feels shapeless.',
        beats: [
            { name: 'Opening image', at: 1, guidance: 'A snapshot of the problem, before anyone names it.' },
            { name: 'Theme stated', at: 5, guidance: 'Someone says what the film is about, usually to a character not ready to hear it.' },
            { name: 'Set-up', at: 8, guidance: 'The world, the flaw, and what is missing. Plant everything you will pay off.' },
            { name: 'Catalyst', at: 12, guidance: 'The knock at the door. External, and not asked for.' },
            { name: 'Debate', at: 18, guidance: 'They try not to go. The audience learns the stakes from their reluctance.' },
            { name: 'Break into Two', at: 25, guidance: 'A choice, not an accident. They step into the new world deliberately.' },
            { name: 'B Story', at: 30, guidance: 'The relationship that carries the theme while the plot carries the action.' },
            { name: 'Fun and games', at: 35, guidance: 'The promise of the premise. What the poster sold.' },
            { name: 'Midpoint', at: 50, guidance: 'A false victory or a false defeat. The stakes stop being personal or start being.' },
            { name: 'Bad guys close in', at: 60, guidance: 'External pressure rises while the team comes apart from inside.' },
            { name: 'All is lost', at: 75, guidance: 'The opposite of the midpoint, and something dies — a person, a plan, or a belief.' },
            { name: 'Dark night of the soul', at: 78, guidance: 'The pause. They have nothing, and that is the point.' },
            { name: 'Break into Three', at: 85, guidance: 'The B story hands over the answer the A story could not find.' },
            { name: 'Finale', at: 90, guidance: 'They act on what they learned, and it costs them.' },
            { name: 'Final image', at: 99, guidance: 'The opposite of the opening image. Proof the change was real.' },
        ],
    },
    'heros-journey': {
        label: "Hero's Journey",
        note: 'Twelve stages. Strongest for a story about someone leaving somewhere and coming back changed.',
        beats: [
            { name: 'Ordinary world', at: 2, guidance: 'What is normal, so the abnormal has something to be measured against.' },
            { name: 'Call to adventure', at: 10, guidance: 'The world asks for something specific.' },
            { name: 'Refusal of the call', at: 15, guidance: 'Fear, duty, or good sense. The refusal is what makes the acceptance mean something.' },
            { name: 'Meeting the mentor', at: 20, guidance: 'Not necessarily a person, and not necessarily right.' },
            { name: 'Crossing the threshold', at: 25, guidance: 'The rules change here, and the character knows it.' },
            { name: 'Tests, allies, enemies', at: 35, guidance: 'Learning the new world by being wrong in it.' },
            { name: 'Approach to the inmost cave', at: 45, guidance: 'Preparation, and the last chance to turn back.' },
            { name: 'The ordeal', at: 55, guidance: 'The confrontation that could genuinely go the other way.' },
            { name: 'Reward', at: 65, guidance: 'They have the thing. It is not enough, or it is not what they thought.' },
            { name: 'The road back', at: 75, guidance: 'The consequence follows them home.' },
            { name: 'Resurrection', at: 88, guidance: 'The final test, in which the lesson is used rather than described.' },
            { name: 'Return with the elixir', at: 97, guidance: 'What they bring back, and who it is for.' },
        ],
    },
    'story-circle': {
        label: 'Story Circle',
        note: 'Eight steps, evenly spaced. The best fit for episodic material and for chapters that each want their own arc.',
        beats: [
            { name: 'You', at: 5, guidance: 'A character in a zone of comfort.' },
            { name: 'Need', at: 15, guidance: 'But they want something.' },
            { name: 'Go', at: 25, guidance: 'They enter an unfamiliar situation.' },
            { name: 'Search', at: 40, guidance: 'Adapt to it.' },
            { name: 'Find', at: 50, guidance: 'Get what they wanted.' },
            { name: 'Take', at: 65, guidance: 'Pay a heavy price for it.' },
            { name: 'Return', at: 80, guidance: 'Then return to their familiar situation.' },
            { name: 'Change', at: 95, guidance: 'Having changed. This is the only step that is not optional.' },
        ],
    },
};

/**
 * The holes: beats with no scene against them.
 *
 * Returned with the beat's guidance attached, because "you have no Midpoint" is
 * a diagnosis and "the midpoint is where what they believed turns out to be
 * wrong" is something a writer can act on this afternoon.
 */
function holesIn(beats) {
    return (beats || [])
        .filter(b => !b.scene_id)
        .map(b => ({ id: b.id, name: b.name, at: b.at, guidance: b.guidance }));
}

/**
 * Which scene a beat probably belongs to, by position in the script.
 *
 * A suggestion, never an assignment — matching by percentage is a guess about
 * pacing and the writer is the one who knows. Forward-only, so a late beat
 * cannot claim an early scene and produce a structure that runs backwards.
 */
function suggestScenes(beats, sceneCount) {
    if (!sceneCount) return [];
    let floor = 0;
    return (beats || []).map(b => {
        const idx = Math.min(sceneCount - 1, Math.max(floor, Math.round((b.at / 100) * (sceneCount - 1))));
        floor = idx;
        return { beat_id: b.id, name: b.name, suggested_scene_index: idx };
    });
}

module.exports = { FRAMEWORKS, holesIn, suggestScenes };
