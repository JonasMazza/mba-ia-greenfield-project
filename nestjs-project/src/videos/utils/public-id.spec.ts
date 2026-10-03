import { PUBLIC_ID_LENGTH } from '../videos.constants';
import { generatePublicId } from './public-id';

describe('generatePublicId', () => {
  it('should produce an id of the configured length', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('should only use the 62-character alphanumeric alphabet', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePublicId()).toMatch(/^[0-9a-zA-Z]+$/);
    }
  });

  it('should not repeat ids across a large sample', () => {
    const ids = new Set(Array.from({ length: 1000 }, generatePublicId));

    expect(ids.size).toBe(1000);
  });
});
