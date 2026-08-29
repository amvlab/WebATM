// @vitest-environment happy-dom
/**
 * Live variable search for the Create Log dialog: the index built from
 * LSVAR attribute discovery, its ranking and lazy drill-down, and the
 * suggestion dropdown's keyboard/mouse behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VariableSearchIndex, VariableSuggestDropdown } from './logVariableSearch';
import { discoverVariableAttributes } from './logVariableChecker';

vi.mock('./logVariableChecker', () => ({
    discoverVariableAttributes: vi.fn(async () => null),
}));

const mockDiscover = vi.mocked(discoverVariableAttributes);

const deps = { sendCommand: vi.fn(), isConnected: () => true };

function makeIndex(onUpdated: () => void = () => undefined): VariableSearchIndex {
    return new VariableSearchIndex(() => deps, onUpdated);
}

beforeEach(() => {
    mockDiscover.mockReset().mockResolvedValue(null);
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('VariableSearchIndex', () => {
    it('seeds traf and sim and searches by name part', async () => {
        mockDiscover.mockImplementation(async (parent: string) =>
            parent === 'traf' ? ['id', 'lat', 'lon', 'gs', 'gsnorth'] :
            parent === 'sim' ? ['simt', 'simdt'] : null);

        const onUpdated = vi.fn();
        const index = makeIndex(onUpdated);
        index.seed();
        await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled());

        expect(index.search('gs')).toEqual(['traf.gs', 'traf.gsnorth']);
        expect(index.search('simd')).toEqual(['sim.simdt']);
    });

    it('ranks prefix matches before substring matches', async () => {
        mockDiscover.mockImplementation(async (parent: string) =>
            parent === 'traf' ? ['lat', 'coslat', 'latspeed'] : null);
        const index = makeIndex();
        index.seed();
        await vi.waitFor(() => expect(index.search('lat').length).toBe(3));

        // 'lat'/'latspeed' start with the query (last component), 'coslat'
        // only contains it
        expect(index.search('lat')).toEqual(['traf.lat', 'traf.latspeed', 'traf.coslat']);
    });

    it('lazily drills into a dotted prefix and streams results in', async () => {
        mockDiscover.mockImplementation(async (parent: string) =>
            parent === 'traf' ? ['perf', 'id'] :
            parent === 'traf.perf' ? ['mass', 'thrust'] : null);
        const onUpdated = vi.fn();
        const index = makeIndex(onUpdated);
        index.seed();
        await vi.waitFor(() => expect(index.search('perf').length).toBe(1));

        // Typing "traf.perf." triggers discovery of that parent
        expect(index.search('traf.perf.')).toEqual([]);
        await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledWith('traf.perf', deps));
        await vi.waitFor(() => expect(index.search('traf.perf.').length).toBe(2));
        expect(index.search('mass')).toEqual(['traf.perf.mass']);
        // Discovery of each parent happens once, not per keystroke
        index.search('traf.perf.');
        index.search('traf.perf.');
        expect(mockDiscover.mock.calls.filter(c => c[0] === 'traf.perf').length).toBe(1);
    });

    it('returns nothing for an empty query', () => {
        expect(makeIndex().search('   ')).toEqual([]);
    });
});

describe('VariableSuggestDropdown', () => {
    let input: HTMLInputElement;
    let listEl: HTMLElement;
    let picks: string[];
    let dropdown: VariableSuggestDropdown;

    beforeEach(async () => {
        vi.useFakeTimers();
        document.body.innerHTML = `
            <input id="v-input" type="text">
            <div id="v-list" style="display: none;"></div>
        `;
        input = document.getElementById('v-input') as HTMLInputElement;
        listEl = document.getElementById('v-list') as HTMLElement;

        mockDiscover.mockImplementation(async (parent: string) =>
            parent === 'traf' ? ['id', 'lat', 'lon'] : null);
        const index = makeIndex(() => dropdown.refresh());
        picks = [];
        dropdown = new VariableSuggestDropdown(input, listEl, index, (name) => picks.push(name));
        index.seed();
        await vi.advanceTimersByTimeAsync(10);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function type(value: string): void {
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(200); // past the debounce
    }

    function press(key: string): KeyboardEvent {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event;
    }

    it('shows matching suggestions while typing', () => {
        type('l');
        expect(dropdown.isOpen()).toBe(true);
        const items = Array.from(listEl.querySelectorAll('[data-suggest]')).map(el => el.textContent?.trim());
        expect(items).toEqual(['traf.lat', 'traf.lon']);
    });

    it('picks with ArrowDown + Enter and consumes the Enter', () => {
        type('l');
        press('ArrowDown'); // move highlight from traf.lat to traf.lon
        const enter = press('Enter');
        expect(picks).toEqual(['traf.lon']);
        expect(enter.defaultPrevented).toBe(true);
        expect(dropdown.isOpen()).toBe(false);
    });

    it('picks on mousedown', () => {
        type('id');
        listEl.querySelector('[data-suggest="traf.id"]')!
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(picks).toEqual(['traf.id']);
    });

    it('Escape closes the dropdown and stops propagating (modal stays open)', () => {
        type('l');
        const documentEscape = vi.fn();
        document.addEventListener('keydown', documentEscape);
        press('Escape');
        expect(dropdown.isOpen()).toBe(false);
        expect(documentEscape).not.toHaveBeenCalled();
        document.removeEventListener('keydown', documentEscape);
    });

    it('leaves Enter alone when no suggestions are shown', () => {
        type('zzz');
        expect(dropdown.isOpen()).toBe(false);
        const enter = press('Enter');
        expect(enter.defaultPrevented).toBe(false);
        expect(picks).toEqual([]);
    });
});
