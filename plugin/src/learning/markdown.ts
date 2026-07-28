export function replaceSection(
  content: string,
  heading: string,
  replacement: string,
): string {
  const expression = sectionExpression(heading, false);
  const block = `## ${heading}\n\n${replacement.trim()}\n\n`;
  return expression.test(content)
    ? content.replace(expression, block)
    : `${content.trimEnd()}\n\n${block}`;
}

export function appendToSection(
  content: string,
  heading: string,
  value: string,
): string {
  const expression = sectionExpression(heading, true);
  if (!expression.test(content)) {
    return `${content.trimEnd()}\n\n## ${heading}\n\n${value.trim()}\n`;
  }
  return content.replace(expression, (_match, title: string, body: string) =>
    `${title}\n${body.trimEnd()}\n${value.trim()}\n\n`);
}

export function sectionContent(content: string, heading: string): string {
  const match = new RegExp(
    `^## ${escapeRegExp(heading)}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    "mu",
  ).exec(content);
  return match?.[1]?.trim() ?? "";
}

function sectionExpression(heading: string, captureBody: boolean): RegExp {
  const body = captureBody ? "([\\s\\S]*?)" : "[\\s\\S]*?";
  return new RegExp(
    `(^## ${escapeRegExp(heading)}[ \\t]*$)${body}(?=^## |(?![\\s\\S]))`,
    "mu",
  );
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
