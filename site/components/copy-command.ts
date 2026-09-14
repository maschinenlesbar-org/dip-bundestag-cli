/**
 * Adds a copy-to-clipboard button to a command or code snippet. The snippet
 * stays plain light-DOM markup, so it is readable (and selectable) before the
 * element upgrades or when JavaScript is off. The button overlays the snippet's
 * top-right corner; the page styles the slotted snippet (its own stylesheet wins
 * over `::slotted`), so reserve room for the button there, e.g.
 * `copy-command pre { padding-inline-end: 5rem }`.
 *
 * The texts are localisable: `label` (button, default "Copy"), plus
 * `copied-label` (shown after copying, default "Copied") and `failed-label`
 * (announced when the clipboard is unavailable), which are read at copy time.
 *
 * @summary Copy button for a slotted command snippet.
 *
 * @slot - The snippet to copy, typically a `<pre><code>` block.
 * @csspart button - The copy button.
 * @cssprop --copy-command-inset - Distance of the button from the top-right corner.
 * @fires copied - Fired after the text was written to the clipboard, with `detail: { text }`.
 *
 * @demo
 * ```html
 * <copy-command><pre><code>/plugin install fim-portal@maschinenlesbar</code></pre></copy-command>
 * ```
 */
class CopyCommand extends HTMLElement {
    /** Button label before copying. */
    private _label: string = 'Copy';
    private _resetTimer: number | undefined;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.render();
    }

    static get observedAttributes() {
        return ['label'];
    }

    /** Button label before copying. */
    get label() {
        return this._label;
    }

    set label(value: string) {
        this._label = value;
        if (this.getAttribute('label') !== value) this.setAttribute('label', value);
        this.render();
    }

    /** The text that gets copied: the slotted snippet, trimmed. */
    get text() {
        return (this.querySelector('code') ?? this).textContent?.trim() ?? '';
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
        if (oldValue === newValue) return;
        if (name === 'label') this.label = newValue || 'Copy';
    }

    disconnectedCallback() {
        window.clearTimeout(this._resetTimer);
    }

    /** Copies the snippet and briefly confirms on the button. */
    async copy() {
        const text = this.text;
        const button = this.shadowRoot?.querySelector('button');
        const status = this.shadowRoot?.querySelector('[role="status"]');
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            if (status) status.textContent = this.getAttribute('failed-label') || 'Copying failed — select the text instead.';
            return;
        }
        const copied = this.getAttribute('copied-label') || 'Copied';
        if (button) button.textContent = copied;
        if (status) status.textContent = copied;
        this.dispatchEvent(new CustomEvent('copied', { detail: { text }, bubbles: true, composed: true }));
        window.clearTimeout(this._resetTimer);
        this._resetTimer = window.setTimeout(() => {
            if (button) button.textContent = this._label;
            if (status) status.textContent = '';
        }, 2000);
    }

    private render() {
        if (!this.shadowRoot) return;
        this.shadowRoot.innerHTML = `
            <style>
                :host { display: block; position: relative; }
                button {
                    position: absolute;
                    inset-block-start: var(--copy-command-inset, 0.4rem);
                    inset-inline-end: var(--copy-command-inset, 0.4rem);
                    padding: 0.2rem 0.6rem;
                    border: 1px solid color-mix(in oklab, var(--root-bg, #fff) 70%, var(--root-fg, #000));
                    border-radius: 0.4rem;
                    background: var(--root-bg, #fff);
                    color: var(--root-fg, #000);
                    font: inherit;
                    font-size: 0.8rem;
                    cursor: pointer;
                }
                button:hover { border-color: var(--brand, currentColor); }
                button:focus-visible { outline: 2px solid var(--brand, currentColor); outline-offset: 2px; }
                .sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
            </style>
            <slot></slot>
            <button part="button" type="button"></button>
            <span class="sr" role="status"></span>
        `;
        const button = this.shadowRoot.querySelector('button');
        if (!button) return;
        button.textContent = this._label;
        button.addEventListener('click', () => this.copy());
    }
}

customElements.define('copy-command', CopyCommand);
