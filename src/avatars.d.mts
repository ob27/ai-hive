export function nameKind(name: string): 'male' | 'female' | 'androgynous';
export function pickAvatar(name: string, kinds: readonly ('male' | 'female' | 'creature')[]): number;
export const ANDROGYNOUS_NAMES: string[];
