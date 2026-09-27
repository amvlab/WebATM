// @vitest-environment happy-dom
/**
 * Characterization tests for the shared escapeHtml helper. Several innerHTML
 * sinks (status toasts, nav search results, file lists) rely on it for both
 * text and quoted-attribute contexts, so all five significant characters must
 * stay covered.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml } from './dom';

describe('escapeHtml', () => {
    it('escapes the five HTML-significant characters', () => {
        expect(escapeHtml(`<img src=x onerror="a" 'b' & more>`)).toBe(
            '&lt;img src=x onerror=&quot;a&quot; &#39;b&#39; &amp; more&gt;'
        );
    });

    it('renders untrusted text inertly in an element context', () => {
        const host = document.createElement('div');
        host.innerHTML = `<span>${escapeHtml('<img src=x>')}</span>`;
        expect(host.querySelector('img')).toBeNull();
        expect(host.textContent).toBe('<img src=x>');
    });

    it('cannot break out of a double-quoted attribute', () => {
        const host = document.createElement('div');
        host.innerHTML = `<span data-name="${escapeHtml('a" onmouseover="x')}"></span>`;
        const span = host.querySelector('span') as HTMLElement;
        expect(span.getAttribute('data-name')).toBe('a" onmouseover="x');
        expect(span.hasAttribute('onmouseover')).toBe(false);
    });

    it('passes plain text through unchanged', () => {
        expect(escapeHtml('EHAM Schiphol 52.3 4.8')).toBe('EHAM Schiphol 52.3 4.8');
    });
});
