/**
 * ~500 memorable words used to generate human-readable signatureNames.
 * Grouped by theme: constellations, trees, minerals, mythical places,
 * animals, elements, weather, geography, colors, and more.
 */
const WORDS: string[] = [
  // Constellations & stars
  "andromeda", "orion", "cassiopeia", "lyra", "vega", "sirius", "polaris",
  "altair", "rigel", "deneb", "antares", "arcturus", "betelgeuse", "capella",
  "canopus", "procyon", "aldebaran", "spica", "regulus", "fomalhaut",
  "achernar", "bellatrix", "mintaka", "alnilam", "alnitak", "mizar",
  "alcor", "dubhe", "merak", "alioth",

  // Trees & plants
  "sequoia", "baobab", "cypress", "juniper", "cedar", "maple", "willow",
  "birch", "aspen", "magnolia", "acacia", "banyan", "redwood", "hemlock",
  "linden", "sycamore", "alder", "hazel", "laurel", "myrtle", "oleander",
  "wisteria", "jasmine", "orchid", "dahlia", "peony", "lotus", "iris",
  "azalea", "camellia",

  // Minerals & gems
  "obsidian", "quartz", "onyx", "jade", "topaz", "opal", "garnet",
  "zircon", "beryl", "pyrite", "agate", "jasper", "basalt", "granite",
  "marble", "slate", "feldspar", "mica", "cobalt", "titanium", "chromium",
  "rhodium", "iridium", "osmium", "bismuth", "galena", "calcite",
  "dolomite", "gypsum", "flint",

  // Mythical places
  "avalon", "olympus", "elysium", "arcadia", "valhalla", "asgard",
  "atlantis", "eldorado", "utopia", "shangri-la", "camelot", "hyperion",
  "lemuria", "midgard", "nirvana", "zion", "eden", "thule", "lyonesse",
  "ithaca", "colchis", "delphi", "knossos", "mycenae", "thebes",
  "carthage", "persepolis", "palmyra", "petra", "angkor",

  // Animals
  "phoenix", "griffin", "falcon", "osprey", "condor", "albatross",
  "peregrine", "kestrel", "merlin", "harrier", "heron", "crane",
  "pelican", "cormorant", "kingfisher", "nightingale", "skylark",
  "wren", "swift", "raven", "panther", "jaguar", "leopard", "lynx",
  "ocelot", "cheetah", "gazelle", "impala", "oryx", "ibex",

  // Ocean & water
  "nautilus", "triton", "nereid", "coral", "tempest", "tsunami",
  "monsoon", "maelstrom", "cascade", "torrent", "fjord", "lagoon",
  "atoll", "reef", "delta", "estuary", "rapids", "geyser", "glacier",
  "iceberg", "tundra", "permafrost", "aurora", "boreal", "solstice",
  "equinox", "zenith", "nadir", "meridian", "horizon",

  // Mountains & geography
  "summit", "pinnacle", "ridge", "plateau", "mesa", "canyon", "ravine",
  "caldera", "crater", "volcano", "fumarole", "obsidian", "basalt",
  "tectonic", "moraine", "cirque", "escarpment", "butte", "bluff",
  "promontory", "archipelago", "isthmus", "peninsula", "strait",
  "channel", "basin", "watershed", "tributary", "confluence", "headwater",

  // Weather & sky
  "nebula", "pulsar", "quasar", "nova", "cosmos", "stellar", "lunar",
  "solar", "astral", "celestial", "twilight", "dusk", "dawn", "daybreak",
  "nightfall", "starlight", "moonbeam", "sunburst", "rainbow", "prism",
  "spectrum", "halo", "corona", "nimbus", "cirrus", "stratus", "cumulus",
  "zephyr", "mistral", "sirocco",

  // Elements & materials
  "carbon", "silicon", "argon", "neon", "helium", "lithium", "sodium",
  "cesium", "strontium", "barium", "radium", "thorium", "uranium",
  "neptunium", "plutonium", "curium", "fermium", "einsteinium",
  "mendelevium", "nobelium", "lawrencium", "rutherford", "seaborg",
  "bohrium", "hassium", "meitnerium", "darmstadt", "roentgen",
  "copernicium", "flerovium",

  // Colors & light
  "crimson", "scarlet", "vermilion", "amber", "saffron", "ochre",
  "sienna", "umber", "cerulean", "azure", "cobalt", "indigo", "violet",
  "magenta", "cerise", "carmine", "burgundy", "maroon", "teal",
  "turquoise", "emerald", "viridian", "chartreuse", "olive", "khaki",
  "ivory", "pearl", "silver", "platinum", "bronze",

  // Music & sound
  "allegro", "adagio", "andante", "crescendo", "fortissimo", "pianissimo",
  "staccato", "legato", "vibrato", "tremolo", "cadenza", "fugue",
  "sonata", "prelude", "nocturne", "requiem", "serenade", "overture",
  "symphony", "concerto", "aria", "ballad", "etude", "rondo",
  "scherzo", "minuet", "bolero", "tango", "waltz", "mazurka",

  // Ancient & history
  "spartan", "athenian", "roman", "viking", "samurai", "centurion",
  "gladiator", "pharaoh", "sultan", "emperor", "monarch", "sentinel",
  "guardian", "herald", "vanguard", "pioneer", "voyager", "navigator",
  "explorer", "pathfinder", "trailblazer", "frontier", "outpost",
  "citadel", "fortress", "bastion", "rampart", "parapet", "battlement",
  "watchtower",

  // Abstract & qualities
  "apex", "vertex", "nexus", "cipher", "axiom", "theorem", "paradox",
  "enigma", "quantum", "vector", "matrix", "tensor", "scalar", "fractal",
  "helix", "spiral", "vortex", "flux", "pulse", "surge", "catalyst",
  "prism", "echo", "resonance", "harmony", "cadence", "rhythm",
  "tempo", "momentum", "velocity",

  // Nature & seasons
  "solstice", "equinox", "blossom", "harvest", "frost", "ember",
  "kindle", "spark", "blaze", "flame", "inferno", "pyre", "beacon",
  "lantern", "lighthouse", "compass", "anchor", "rudder", "helm",
  "keel", "mast", "bowsprit", "starboard", "portside", "leeward",
  "windward", "current", "drift", "voyage", "odyssey",
];

// Deduplicate (some words appear in multiple categories)
const UNIQUE_WORDS = [...new Set(WORDS)];

/**
 * Picks a signatureName from the word list based on the signature hash.
 * If the deterministic pick collides with an existing name in the scope,
 * walks forward through the list. Falls back to numeric suffix if all
 * words are exhausted.
 *
 * @param signature - The SHA-256 hex hash of the DAG
 * @param usedNames - Set of signatureNames already taken in this (orgId) scope
 * @returns A unique signatureName
 */
export function pickSignatureName(
  signature: string,
  usedNames: Set<string>,
): string {
  // Use first 8 hex chars of signature as a seed index
  const seed = parseInt(signature.slice(0, 8), 16);
  const total = UNIQUE_WORDS.length;

  // Try the deterministic pick first, then walk forward
  for (let offset = 0; offset < total; offset++) {
    const word = UNIQUE_WORDS[(seed + offset) % total];
    if (!usedNames.has(word)) {
      return word;
    }
  }

  // All words exhausted — add numeric suffix to the deterministic pick
  const baseWord = UNIQUE_WORDS[seed % total];
  let suffix = 2;
  while (usedNames.has(`${baseWord}-${suffix}`)) {
    suffix++;
  }
  return `${baseWord}-${suffix}`;
}

/** Exported for testing */
export const WORD_COUNT = UNIQUE_WORDS.length;
