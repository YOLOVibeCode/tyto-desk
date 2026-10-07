/**
 * The decisions table of docs/IMPLEMENTATION.md §22: each row starts `| D<n> |`, and the numbers are cited across the
 * plan, so a number is never reused and rows only ever append (a new decision takes the number after the highest).
 */

/**
 * The decision numbers of §22's table rows, in the order they appear: the rows between the `## 22.` heading and the next
 * `## ` heading. Rows of other sections' tables never count.
 * @param {string} markdown docs/IMPLEMENTATION.md
 * @returns {number[]}
 */
export function decisionNumbers(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## 22\. /.test(line));
  /** @type {number[]} */
  const numbers = [];
  if (start !== -1) {
    for (const line of lines.slice(start + 1)) {
      if (/^## /.test(line)) break;
      const row = /^\| D(\d+) \|/.exec(line);
      if (row !== null) numbers.push(Number(row[1]));
    }
  }
  if (numbers.length === 0) throw new Error("docs/IMPLEMENTATION.md §22 has no decision rows (| D<n> | …)");
  return numbers;
}

/**
 * Each row whose number does not come after the one before it, as `D<n> repeats D<n>` or `D<n> follows D<m>`.
 * @param {readonly number[]} numbers
 * @returns {string[]}
 */
export function decisionProblems(numbers) {
  /** @type {string[]} */
  const problems = [];
  for (let i = 1; i < numbers.length; i += 1) {
    const before = numbers[i - 1] ?? 0;
    const number = numbers[i] ?? 0;
    if (number === before) problems.push(`D${number} repeats D${before}`);
    else if (number < before) problems.push(`D${number} follows D${before}`);
  }
  return problems;
}
