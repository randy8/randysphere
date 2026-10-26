import { allTags, citiesOf, viewForTag } from './archive.ts';
import type { Archive } from './archive.ts';
import { lightboxPhoto } from './lightbox-data.ts';
import type { ExhibitionData } from './exhibition-model.ts';

/**
 * Everything /exposures/exhibition/ needs, as one JSON payload: every
 * public photograph, as the lightbox already describes it (the same image
 * sources, at full size), plus what the exhibition filters and labels by —
 * its tags, its places, its date — and each tag's display title. The page
 * picks its subset in the browser, from the URL, the way Saved and Share
 * already do, so one static page serves every source.
 *
 * `photos` arrives in Selected Work's order; that's the sequence the
 * exhibition plays when nothing narrower is asked for.
 */
export function exhibitionData(archive: Archive, photos: Archive['photos']): ExhibitionData {
  return {
    photos: photos.map((entry) => ({
      ...lightboxPhoto(entry),
      tags: entry.tags,
      places: citiesOf(archive, entry).map((city) => city.name),
      date: entry.photo.camera?.takenAt?.slice(0, 10) ?? entry.roll.date,
    })),
    titles: Object.fromEntries(
      allTags(archive).map((tag) => [tag, viewForTag(archive, tag).title]),
    ),
  };
}
