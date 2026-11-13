export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Known bug: words after the first are not capitalized, and empty input throws.
export function titleCase(text) {
  const words = text.split(" ");
  return capitalize(words[0]) + " " + words.slice(1).join(" ");
}
