import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/messages";
import type { Locale } from "@/lib/types";
import type { TypedDecimal } from "./number";
import { DecimalNote } from "@/components/i18n/decimal-note";
import { checkActivityParse } from "./number";
import { useDecimalInput, type DecimalInput } from "./use-decimal-input";

/**
 * The page-level half of "a language change cannot change a typed quantity"
 * (F09; independent review P2-2). A component holding text typed under one
 * locale renders under another — what a language switch does to a mounted
 * form — and must show the same number written the new way, read under the
 * locale it is now written in. Rendered on the server renderer, which runs a
 * component's render-phase state update exactly as the browser does, so no
 * jsdom is needed.
 */
function renderUnder(locale: Locale, initial: TypedDecimal) {
  let seen: Pick<DecimalInput, "text" | "locale" | "parsed" | "otherReading"> | null = null;
  function Field() {
    const input = useDecimalInput(initial);
    seen = { text: input.text, locale: input.locale, parsed: input.parsed, otherReading: input.otherReading };
    return createElement("input", { value: input.text, readOnly: true });
  }
  const html = renderToString(createElement(IntlProvider, { locale, messages: MESSAGES[locale], children: createElement(Field) }));
  return { seen: seen!, html };
}

describe("useDecimalInput — a language switch keeps the number", () => {
  it("Turkish 1.234 (1234) under English is 1234, not 1.234", () => {
    const { seen, html } = renderUnder("en", { text: "1.234", locale: "tr" });
    expect(seen.text).toBe("1234");
    expect(seen.locale).toBe("en");
    expect(seen.parsed).toEqual({ ok: true, value: 1234, grouped: false });
    expect(html).toContain('value="1234"');
  });

  it("English 1.234 (1.234) under Turkish is 1,234, not 1234", () => {
    const { seen } = renderUnder("tr", { text: "1.234", locale: "en" });
    expect(seen.text).toBe("1,234");
    expect(seen.parsed).toEqual({ ok: true, value: 1.234, grouped: false });
    // Still readable both ways, so the screen keeps naming the other reading.
    expect(seen.otherReading).toBe(1234);
  });

  it("Turkish 1.234,5 under English is 1234.5", () => {
    const { seen } = renderUnder("en", { text: "1.234,5", locale: "tr" });
    expect(seen.text).toBe("1234.5");
    expect(seen.parsed).toEqual({ ok: true, value: 1234.5, grouped: false });
  });

  it("text the old locale refused is kept as typed, and read under the new one", () => {
    const { seen } = renderUnder("en", { text: "0.500", locale: "tr" });
    expect(seen.text).toBe("0.500");
    expect(seen.parsed).toEqual({ ok: true, value: 0.5, grouped: false });
  });

  it("within one locale nothing is rewritten", () => {
    const { seen } = renderUnder("tr", { text: "1.234", locale: "tr" });
    expect(seen.text).toBe("1.234");
    expect(seen.parsed).toEqual({ ok: true, value: 1234, grouped: true });
    expect(seen.otherReading).toBe(1.234);
  });

  it("a value put into the field (opening a record) is written and read in the current locale", () => {
    // setValue during render: the server renderer replays the update as the
    // browser does after an event, so the pairing is what the spec sees.
    function Field({ value }: { value: number }) {
      const input = useDecimalInput();
      if (input.text === "") input.setValue(value);
      return createElement("output", null, `${input.locale}|${input.text}|${input.parsed.ok ? input.parsed.value : input.parsed.reason}`);
    }
    const render = (locale: Locale, value: number) =>
      renderToString(createElement(IntlProvider, { locale, messages: MESSAGES[locale], children: createElement(Field, { value }) }));
    expect(render("tr", 1.234)).toContain("tr|1,234|1.234");
    expect(render("en", 1.234)).toContain("en|1.234|1.234");
    expect(render("tr", 1234.5)).toContain("tr|1234,5|1234.5");
  });

  it("typed text is tagged with the current locale", () => {
    function Field() {
      const input = useDecimalInput();
      if (input.text === "") input.setText("1.234");
      return createElement("output", null, `${input.locale}|${input.parsed.ok ? input.parsed.value : input.parsed.reason}`);
    }
    const render = (locale: Locale) =>
      renderToString(createElement(IntlProvider, { locale, messages: MESSAGES[locale], children: createElement(Field) }));
    expect(render("tr")).toContain("tr|1234");
    expect(render("en")).toContain("en|1.234");
  });

  it("starts empty, in the current locale", () => {
    function Field() {
      const input = useDecimalInput();
      return createElement("output", null, `${input.locale}|${input.text}|${input.parsed.ok ? "ok" : input.parsed.reason}`);
    }
    const html = renderToString(createElement(IntlProvider, { locale: "tr", messages: MESSAGES.tr, children: createElement(Field) }));
    expect(html).toContain("tr||empty");
  });
});

/**
 * QA BUG-06: typing `178,` on the way to `178,5` must not turn the field red.
 * The refusal waits while the user is in the field (`typing`) and shows once
 * they leave it (`blur`); `parsed` refuses the text throughout, so nothing can
 * save it. A field opened with such text is not being typed in.
 */
describe("useDecimalInput — a pending separator waits for blur", () => {
  function render(locale: Locale, steps: (input: DecimalInput) => void) {
    function Field() {
      const input = useDecimalInput();
      steps(input);
      const check = checkActivityParse(input.parsed);
      return createElement("div", null,
        createElement("output", null, `typing=${input.typing}|ok=${input.parsed.ok}`),
        createElement(DecimalNote, { id: "n", check, otherReading: input.otherReading, locale: input.locale, typing: input.typing }));
    }
    return renderToString(createElement(IntlProvider, { locale, messages: MESSAGES[locale], children: createElement(Field) }));
  }
  const refusal = (locale: Locale) => String(MESSAGES[locale].numbers.invalid).split("{")[0];

  it("178, while typing: no refusal on screen, and still not a number", () => {
    const html = render("tr", (input) => { if (input.text === "") input.setText("178,"); });
    expect(html).toContain("typing=true|ok=false");
    expect(html).not.toContain(refusal("tr"));
  });

  it("178, after leaving the field: the refusal shows", () => {
    let left = false;
    const html = render("tr", (input) => {
      if (input.text === "") input.setText("178,");
      else if (!left) { left = true; input.blur(); }
    });
    expect(html).toContain("typing=false|ok=false");
    expect(html).toContain(refusal("tr"));
  });

  it("text that is wrong for another reason is refused while typing", () => {
    const html = render("tr", (input) => { if (input.text === "") input.setText("17a"); });
    expect(html).toContain("typing=false|ok=false");
    expect(html).toContain(refusal("tr"));
  });

  it("a field opened with such text is not being typed in: refused at once", () => {
    function Field() {
      const input = useDecimalInput({ text: "178,", locale: "tr" });
      return createElement("output", null, `typing=${input.typing}`);
    }
    const html = renderToString(createElement(IntlProvider, { locale: "tr", messages: MESSAGES.tr, children: createElement(Field) }));
    expect(html).toContain("typing=false");
  });

  it("the finished number is accepted in both locales", () => {
    expect(render("tr", (input) => { if (input.text === "") input.setText("178,5"); })).toContain("typing=false|ok=true");
    expect(render("en", (input) => { if (input.text === "") input.setText("178.5"); })).toContain("typing=false|ok=true");
  });
});

