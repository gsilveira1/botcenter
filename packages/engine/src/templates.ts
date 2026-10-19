import {
  BotMessageContent,
  BUTTON_TITLE_MAX_LENGTH,
  BUTTONS_TEXT_MAX_LENGTH,
  CAPTION_MAX_LENGTH,
  FILE_NAME_MAX_LENGTH,
  FOOTER_MAX_LENGTH,
  LIST_BUTTON_TEXT_MAX_LENGTH,
  LIST_ROW_DESCRIPTION_MAX_LENGTH,
  LIST_ROW_TITLE_MAX_LENGTH,
  LIST_SECTION_TITLE_MAX_LENGTH,
  LIST_TEXT_MAX_LENGTH,
  TEMPLATE_VARIABLE_PATTERN,
  TEXT_MAX_LENGTH,
} from '@botcenter/contracts';
import type { Diagnostic, Variables } from './types.js';

type Path = (string | number)[];

/**
 * Replaces each `{{name}}` with the value of the variable. Numbers and booleans become their
 * JavaScript text (`72.5`, `true`). The replacement is one pass: a value that contains `{{x}}`
 * stays as text (no second expansion). A variable that does not exist becomes an empty text and
 * gives a `template_variable_unknown` diagnostic. WhatsApp text is plain text, so there is no escape.
 */
export function renderTemplate(
  template: string,
  variables: Variables,
  diagnostics: Diagnostic[],
  path: Path,
): string {
  return template.replace(new RegExp(TEMPLATE_VARIABLE_PATTERN, 'g'), (_match, name: string) => {
    if (!Object.hasOwn(variables, name)) {
      diagnostics.push({
        code: 'template_variable_unknown',
        severity: 'warning',
        message: `The template uses the unknown variable "${name}". It rendered as an empty text.`,
        path,
      });
      return '';
    }
    return String(variables[name]);
  });
}

/**
 * Cuts a text to `max` UTF-16 code units (the unit of the Zod `max()` check) and does not cut a
 * surrogate pair. It gives a `value_truncated` diagnostic when it cuts.
 */
export function truncate(
  value: string,
  max: number,
  diagnostics: Diagnostic[],
  path: Path,
): string {
  if (value.length <= max) {
    return value;
  }
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  diagnostics.push({
    code: 'value_truncated',
    severity: 'warning',
    message: `The rendered text has ${value.length} characters. The engine cut it to ${max}.`,
    path,
  });
  return value.slice(0, end);
}

function renderField(
  value: string,
  max: number,
  variables: Variables,
  diagnostics: Diagnostic[],
  path: Path,
): string {
  return truncate(renderTemplate(value, variables, diagnostics, path), max, diagnostics, path);
}

function renderOptional(
  value: string | undefined,
  max: number,
  variables: Variables,
  diagnostics: Diagnostic[],
  path: Path,
): string | undefined {
  return value === undefined ? undefined : renderField(value, max, variables, diagnostics, path);
}

/** Copies an object without the keys that have the value `undefined`. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Renders the text fields of a message: `text`, `caption`, `file_name`, `footer`, button titles,
 * `button_text`, section titles, row titles, and row descriptions. Ids and URLs stay as they are.
 * Each field is cut to its WhatsApp limit. If the rendered message is not valid (for example, a
 * text that is empty after the render), the function returns `null` and gives a `message_invalid` error.
 */
export function renderMessage(
  message: BotMessageContent,
  variables: Variables,
  diagnostics: Diagnostic[],
  path: Path,
): BotMessageContent | null {
  const field = (value: string, max: number, ...sub: Path) =>
    renderField(value, max, variables, diagnostics, [...path, ...sub]);
  const optional = (value: string | undefined, max: number, ...sub: Path) =>
    renderOptional(value, max, variables, diagnostics, [...path, ...sub]);

  let rendered: BotMessageContent;
  switch (message.type) {
    case 'text':
      rendered = { type: 'text', text: field(message.text, TEXT_MAX_LENGTH, 'text') };
      break;
    case 'media':
      rendered = compact({
        ...message,
        caption: optional(message.caption, CAPTION_MAX_LENGTH, 'caption'),
        file_name: optional(message.file_name, FILE_NAME_MAX_LENGTH, 'file_name'),
      });
      break;
    case 'buttons':
      rendered = compact({
        type: 'buttons',
        text: field(message.text, BUTTONS_TEXT_MAX_LENGTH, 'text'),
        buttons: message.buttons.map((button, index) => ({
          id: button.id,
          title: field(button.title, BUTTON_TITLE_MAX_LENGTH, 'buttons', index, 'title'),
        })),
        footer: optional(message.footer, FOOTER_MAX_LENGTH, 'footer'),
      });
      break;
    case 'list':
      rendered = {
        type: 'list',
        text: field(message.text, LIST_TEXT_MAX_LENGTH, 'text'),
        button_text: field(message.button_text, LIST_BUTTON_TEXT_MAX_LENGTH, 'button_text'),
        sections: message.sections.map((section, sectionIndex) => ({
          title: field(
            section.title,
            LIST_SECTION_TITLE_MAX_LENGTH,
            'sections',
            sectionIndex,
            'title',
          ),
          rows: section.rows.map((row, rowIndex) =>
            compact({
              id: row.id,
              title: field(
                row.title,
                LIST_ROW_TITLE_MAX_LENGTH,
                'sections',
                sectionIndex,
                'rows',
                rowIndex,
                'title',
              ),
              description: optional(
                row.description,
                LIST_ROW_DESCRIPTION_MAX_LENGTH,
                'sections',
                sectionIndex,
                'rows',
                rowIndex,
                'description',
              ),
            }),
          ),
        })),
      };
      break;
  }

  const checked = BotMessageContent.safeParse(rendered);
  if (!checked.success) {
    diagnostics.push({
      code: 'message_invalid',
      severity: 'error',
      message: `The rendered message is not valid, so the engine did not send it: ${checked.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      path,
    });
    return null;
  }
  return checked.data;
}
