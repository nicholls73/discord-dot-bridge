import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../src/admin-copy.js.txt', import.meta.url), 'utf8');

function setup(writeText?: (text: string) => Promise<void>, fallback: () => boolean = () => false) {
  let click!: () => Promise<void>;
  const field = {
    value: 'https://displayed.example.test/mcp', selectionStart: 2, selectionEnd: 5, selectionDirection: 'forward',
    focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(),
  };
  const button = { addEventListener: (_: string, handler: typeof click) => { click = handler; }, setAttribute: vi.fn(), removeAttribute: vi.fn(), focus: vi.fn() };
  const status = { textContent: 'Select and copy this URL. It contains no credentials.' };
  const elements = { 'codex-mcp-url': field, 'codex-mcp-copy-button': button, 'codex-mcp-copy': status };
  const execCommand = vi.fn(fallback);
  const timers: (() => void)[] = [];
  const clearTimeout = vi.fn();
  runInNewContext(script, {
    document: { getElementById: (id: keyof typeof elements) => elements[id], activeElement: button, execCommand },
    navigator: { clipboard: writeText ? { writeText } : undefined },
    setTimeout: (callback: () => void) => timers.push(callback), clearTimeout,
  });
  return { click, field, button, status, execCommand, timers, clearTimeout };
}

describe('admin URL copy', () => {
  it('copies the current field only on activation and resets confirmation after each copy', async () => {
    const write = vi.fn(async () => {});
    const ui = setup(write);
    expect(write).not.toHaveBeenCalled();
    await ui.click();
    expect(write).toHaveBeenLastCalledWith(ui.field.value);
    expect(ui.status.textContent).toBe('Copied');
    ui.field.value = 'https://changed.example.test/mcp';
    await ui.click();
    expect(write).toHaveBeenLastCalledWith(ui.field.value);
    expect(ui.clearTimeout).toHaveBeenLastCalledWith(1);
    ui.timers[1]!();
    expect(ui.status.textContent).toContain('Select and copy');
    expect(ui.execCommand).not.toHaveBeenCalled();
  });

  it('waits for successful completion and ignores overlapping clicks', async () => {
    let resolve!: () => void;
    const write = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const ui = setup(write);
    const first = ui.click();
    await ui.click();
    expect(write).toHaveBeenCalledTimes(1);
    expect(ui.status.textContent).toBe('Copying…');
    resolve();
    await first;
    expect(ui.status.textContent).toBe('Copied');
    expect(ui.button.removeAttribute).toHaveBeenCalledWith('aria-disabled');
  });

  it.each([undefined, async () => { throw new Error('denied'); }])('falls back when clipboard access is unavailable or denied', async (write) => {
    const ui = setup(write, () => true);
    await ui.click();
    expect(ui.execCommand).toHaveBeenCalledWith('copy');
    expect(ui.field.select).toHaveBeenCalled();
    expect(ui.field.setSelectionRange).toHaveBeenCalledWith(2, 5, 'forward');
    expect(ui.button.focus).toHaveBeenCalled();
    expect(ui.status.textContent).toBe('Copied');
  });

  it.each([() => false, () => { throw new Error('blocked'); }])('keeps the URL selected with honest feedback when both copy methods fail', async (fallback) => {
    const ui = setup(async () => { throw new Error('denied'); }, fallback);
    await ui.click();
    expect(ui.status.textContent).toBe('Could not copy. Select and copy this URL.');
    expect(ui.field.select).toHaveBeenCalled();
    expect(ui.button.focus).not.toHaveBeenCalled();
    expect(ui.timers).toHaveLength(0);
    await ui.click();
    expect(ui.execCommand).toHaveBeenCalledTimes(2);
  });
});
