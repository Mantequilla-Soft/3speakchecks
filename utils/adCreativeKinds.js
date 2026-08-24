/**
 * What kind of asset a creative is.
 *
 * Its own module, and not part of adModel.js where it started, purely to break a
 * cycle: adFormats.js needs these constants to declare what each format requires,
 * and adModel.js needs adFormats.js to decide whether a given creative satisfies the
 * campaign holding it. Two files that need each other and one shared enum between
 * them — so the enum moves out and both require it.
 *
 * adModel.js still re-exports CREATIVE_KINDS, so every existing caller is unchanged.
 *
 * A kind is not a judgement about whether something can serve. It used to be: an
 * image meant "asset, never servable", because the only product was a spot spliced
 * into HLS and a still is not something HLS can express. That is now a fact about
 * the FORMAT, not about the file — a still is exactly what a banner is made of. Ask
 * adFormats.js what a campaign needs; ask this only what a file is.
 */
const CREATIVE_KINDS = Object.freeze({ VIDEO: 'video', IMAGE: 'image' });

module.exports = { CREATIVE_KINDS };
