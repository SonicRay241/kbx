export const ACCENTS = [
  "bg-slate-600 dark:bg-slate-400",
  "bg-amber-600 dark:bg-amber-400",
  "bg-green-600 dark:bg-green-400",
  "bg-sky-600 dark:bg-sky-400",
  "bg-violet-600 dark:bg-violet-400",
  "bg-rose-600 dark:bg-rose-400",
];

export const SOFT_ACCENTS = [
  "bg-slate-600/15 dark:bg-slate-400/15",
  "bg-amber-600/15 dark:bg-amber-400/15",
  "bg-green-600/15 dark:bg-green-400/15",
  "bg-sky-600/15 dark:bg-sky-400/15",
  "bg-violet-600/15 dark:bg-violet-400/15",
  "bg-rose-600/15 dark:bg-rose-400/15",
];

export const OUTLINE_ACCENTS = [
  "border text-slate-600 dark:text-slate-400 border-slate-600 dark:border-slate-400",
  "border text-amber-600 dark:text-amber-400 border-amber-600 dark:border-amber-400",
  "border text-green-600 dark:text-green-400 border-green-600 dark:border-green-400",
  "border text-sky-600 dark:text-sky-400 border-sky-600 dark:border-sky-400",
  "border text-violet-600 dark:text-violet-400 border-violet-600 dark:border-violet-400",
  "border text-rose-600 dark:text-rose-400 border-rose-600 dark:border-rose-400",
];
/** Soft fill + matching outline, keyed by column index (list-page state badge). */
export function softAccentBadge(index: number) {
  return `text-primary-foreground font-normal ${SOFT_ACCENTS[index % SOFT_ACCENTS.length]} ${OUTLINE_ACCENTS[index % OUTLINE_ACCENTS.length]}`;
}
