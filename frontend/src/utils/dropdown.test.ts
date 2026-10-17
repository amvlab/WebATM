// @vitest-environment happy-dom
/**
 * Tests for the pure ranking helper shared by the console autocompletes and
 * the Create Aircraft modal's type dropdown, plus the keyboard navigation of
 * the shared Dropdown widget itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Dropdown, rankByPrefixThenContains } from './dropdown';

describe('rankByPrefixThenContains', () => {
    const items = ['A320', 'A321', 'B738', 'E75L', 'GLF6'] as const;

    it('returns a copy of the full list for an empty query', () => {
        const ranked = rankByPrefixThenContains(items, '');
        expect(ranked).toEqual([...items]);
        expect(ranked).not.toBe(items);
    });

    it('ranks prefix matches before substring matches', () => {
        expect(rankByPrefixThenContains(items, 'A3')).toEqual(['A320', 'A321']);
        expect(rankByPrefixThenContains(items, '7')).toEqual(['B738', 'E75L']);
        expect(rankByPrefixThenContains(items, 'B7')).toEqual(['B738']);
    });

    it('matches case-insensitively against the items', () => {
        expect(rankByPrefixThenContains(['a320', 'b738'], 'A3')).toEqual(['a320']);
    });

    it('returns an empty list when nothing matches', () => {
        expect(rankByPrefixThenContains(items, 'ZZZ')).toEqual([]);
    });
});

describe('Dropdown keyboard navigation', () => {
    let dropdown: Dropdown<string>;
    let onSelect: ReturnType<typeof vi.fn<(value: string, index: number) => void>>;

    beforeEach(() => {
        document.body.innerHTML = '';
        onSelect = vi.fn<(value: string, index: number) => void>();
        dropdown = new Dropdown<string>({
            container: document.body,
            rootClass: 'test-dropdown',
            itemClass: 'test-item',
            renderItem: value => value,
            onSelect,
        });
        dropdown.setItems(['A320', 'A321', 'B738']);
    });

    const selectedText = (): string | null =>
        document.querySelector('.test-item.selected')?.textContent ?? null;

    it('starts with nothing selected', () => {
        expect(dropdown.getSelectedIndex()).toBe(-1);
        expect(selectedText()).toBeNull();
    });

    it('ArrowUp with no selection selects the top item', () => {
        expect(dropdown.handleKey('ArrowUp')).toBe(true);
        expect(dropdown.getSelectedIndex()).toBe(0);
        expect(selectedText()).toBe('A320');
    });

    it('ArrowUp on the top item keeps it selected', () => {
        dropdown.handleKey('ArrowDown');
        expect(dropdown.getSelectedIndex()).toBe(0);
        dropdown.handleKey('ArrowUp');
        dropdown.handleKey('ArrowUp');
        expect(dropdown.getSelectedIndex()).toBe(0);
        expect(selectedText()).toBe('A320');
    });

    it('ArrowUp moves the selection up from a lower item', () => {
        dropdown.handleKey('ArrowDown');
        dropdown.handleKey('ArrowDown');
        expect(dropdown.getSelectedIndex()).toBe(1);
        dropdown.handleKey('ArrowUp');
        expect(dropdown.getSelectedIndex()).toBe(0);
    });

    it('ArrowDown walks down and stops at the last item', () => {
        dropdown.handleKey('ArrowDown');
        dropdown.handleKey('ArrowDown');
        dropdown.handleKey('ArrowDown');
        dropdown.handleKey('ArrowDown');
        expect(dropdown.getSelectedIndex()).toBe(2);
        expect(selectedText()).toBe('B738');
    });

    it('Enter selects the highlighted item and does nothing without a selection', () => {
        expect(dropdown.handleKey('Enter')).toBe(false);
        expect(onSelect).not.toHaveBeenCalled();
        dropdown.handleKey('ArrowUp');
        expect(dropdown.handleKey('Enter')).toBe(true);
        expect(onSelect).toHaveBeenCalledWith('A320', 0);
    });

    it('ignores keys when hidden', () => {
        dropdown.hide();
        expect(dropdown.handleKey('ArrowUp')).toBe(false);
        expect(dropdown.getSelectedIndex()).toBe(-1);
    });
});
