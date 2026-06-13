// @vitest-environment happy-dom
/**
 * Tests for the console command history navigation (extracted from
 * Console). Runs under happy-dom for the localStorage persistence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CommandHistory } from './CommandHistory';

describe('CommandHistory', () => {
    let history: CommandHistory;

    beforeEach(() => {
        localStorage.clear();
        history = new CommandHistory('test-history', 3);
    });

    it('appends commands newest-last, ignoring blank input', () => {
        history.add('CRE KL123');
        history.add('   ');
        history.add('HDG KL123 90');
        expect(history.entries).toEqual(['CRE KL123', 'HDG KL123 90']);
    });

    it('caps the history at maxEntries, dropping the oldest', () => {
        ['a', 'b', 'c', 'd'].forEach(cmd => history.add(cmd));
        expect(history.entries).toEqual(['b', 'c', 'd']);
    });

    it('persists across instances via storage', () => {
        history.add('CRE KL123');

        const restored = new CommandHistory('test-history', 3);
        restored.load();
        expect(restored.entries).toEqual(['CRE KL123']);
    });

    describe('navigation', () => {
        beforeEach(() => {
            history.add('first');
            history.add('second');
            history.add('third');
        });

        it('previous() walks from newest to oldest and sticks at the oldest', () => {
            expect(history.previous()).toBe('third');
            expect(history.previous()).toBe('second');
            expect(history.previous()).toBe('first');
            expect(history.previous()).toBe('first'); // no cycling
        });

        it('next() walks back toward newest and returns to the fresh line', () => {
            history.previous(); // third
            history.previous(); // second

            expect(history.next()).toBe('third');
            expect(history.next()).toBe(''); // fresh input line
            expect(history.next()).toBeNull(); // not navigating any more
        });

        it('next() does nothing from the fresh line', () => {
            expect(history.next()).toBeNull();
        });

        it('resetNavigation() returns to the fresh line so previous() starts at newest', () => {
            history.previous(); // third
            history.previous(); // second
            history.resetNavigation();
            expect(history.previous()).toBe('third');
        });

        it('previous() on an empty history returns null', () => {
            const empty = new CommandHistory('empty-history');
            expect(empty.previous()).toBeNull();
        });
    });
});
