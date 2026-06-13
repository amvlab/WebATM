// @vitest-environment happy-dom
/**
 * Tests for the BasePanel DOM-binding helpers that replace the repeated
 * getElementById + null-check + addEventListener boilerplate in panels.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BasePanel } from './BasePanel';

class TestPanel extends BasePanel {
    constructor() {
        super('#test-panel');
    }
    protected onInit(): void {}
    public update(): void {}

    // Expose protected helpers for testing
    public testBindClick(id: string, handler: () => void) {
        return this.bindClick(id, handler);
    }
    public testBindInput(id: string, handler: (value: string) => void) {
        return this.bindInput(id, handler);
    }
    public testBindCheckbox(id: string, handler: (checked: boolean) => void) {
        return this.bindCheckbox(id, handler);
    }
    public testBindChange(id: string, handler: (value: string) => void) {
        return this.bindChange(id, handler);
    }
    public testSetInputValue(id: string, value: string | number) {
        this.setInputValue(id, value);
    }
    public testSetChecked(id: string, checked: boolean) {
        this.setChecked(id, checked);
    }
    public testSetText(id: string, text: string) {
        this.setText(id, text);
    }
}

describe('BasePanel DOM helpers', () => {
    let panel: TestPanel;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="test-panel">
                <button id="btn">Go</button>
                <input id="num" type="range" value="5">
                <input id="check" type="checkbox">
                <select id="sel"><option value="a">A</option><option value="b">B</option></select>
                <span id="label"></span>
            </div>
        `;
        panel = new TestPanel();
        panel.init();
    });

    it('bindClick attaches a click handler and returns the element', () => {
        const handler = vi.fn();
        const el = panel.testBindClick('btn', handler);
        expect(el).not.toBeNull();
        el!.click();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('bindClick returns null for missing elements without throwing', () => {
        expect(panel.testBindClick('nope', vi.fn())).toBeNull();
    });

    it('bindInput passes the current input value to the handler', () => {
        const handler = vi.fn();
        panel.testBindInput('num', handler);
        const input = document.getElementById('num') as HTMLInputElement;
        input.value = '7';
        input.dispatchEvent(new Event('input'));
        expect(handler).toHaveBeenCalledWith('7');
    });

    it('bindCheckbox passes the checked state on change', () => {
        const handler = vi.fn();
        panel.testBindCheckbox('check', handler);
        const box = document.getElementById('check') as HTMLInputElement;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(handler).toHaveBeenCalledWith(true);
    });

    it('bindChange passes the selected value on change', () => {
        const handler = vi.fn();
        panel.testBindChange('sel', handler);
        const sel = document.getElementById('sel') as HTMLSelectElement;
        sel.value = 'b';
        sel.dispatchEvent(new Event('change'));
        expect(handler).toHaveBeenCalledWith('b');
    });

    it('bound listeners are removed on destroy', () => {
        const handler = vi.fn();
        panel.testBindClick('btn', handler);
        panel.destroy();
        (document.getElementById('btn') as HTMLElement).click();
        expect(handler).not.toHaveBeenCalled();
    });

    it('setInputValue, setChecked and setText update elements and ignore missing IDs', () => {
        panel.testSetInputValue('num', 9);
        panel.testSetChecked('check', true);
        panel.testSetText('label', 'hello');
        expect((document.getElementById('num') as HTMLInputElement).value).toBe('9');
        expect((document.getElementById('check') as HTMLInputElement).checked).toBe(true);
        expect(document.getElementById('label')!.textContent).toBe('hello');

        // Missing IDs must not throw
        panel.testSetInputValue('nope', 1);
        panel.testSetChecked('nope', false);
        panel.testSetText('nope', 'x');
    });
});
