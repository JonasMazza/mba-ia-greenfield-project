import { customAlphabet } from 'nanoid';
import { PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH } from '../videos.constants';

const nanoid = customAlphabet(PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH);

/**
 * The only identifier the API ever exposes (TD-06). Kept separate from the
 * internal UUID so the public URL can change without moving storage objects.
 */
export function generatePublicId(): string {
  return nanoid();
}
