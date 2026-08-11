export const GAMES = [
  {
    slug: 'irontide', name: 'Iron Tide',
    modes: [
      { slug: 'campaign', name: 'Campaign War Score', direction: 'desc', unit: 'points', min: 0, max: 10_000_000, description: 'Objectives, enemy tonnage and survival across a campaign battle.' },
      { slug: 'tonnage', name: 'Enemy Tonnage Sunk', direction: 'desc', unit: 'points', min: 0, max: 5_000_000, description: 'Community-submitted enemy tonnage sunk in one battle.' },
      { slug: 'theater-speed', name: 'Theater Speed Run', direction: 'asc', unit: 'time', min: 20, max: 86_400, description: 'Community-submitted theater completion time; cheat-marked runs are excluded.' }
    ]
  },
  { slug: 'pvp', name: 'PVP Arena', modes: [
    { slug: 'wins', name: 'Match Wins', direction: 'desc', unit: 'points', min: 0, max: 100_000, description: 'Community-submitted multiplayer victories.' },
    { slug: 'kills', name: 'Match Kills', direction: 'desc', unit: 'points', min: 0, max: 2_000, description: 'Most eliminations in one completed match.' }
  ] },
  { slug: 'battle-sim', name: '2D Battle Simulator', modes: [
    { slug: 'largest-battle', name: 'Largest Battle Won', direction: 'desc', unit: 'points', min: 0, max: 100_000, description: 'Units defeated in a completed simulation.' }
  ] },
  { slug: 'army-sim', name: 'Army Sim', modes: [
    { slug: 'wins', name: 'Battle Wins', direction: 'desc', unit: 'points', min: 0, max: 100_000, description: 'Completed victories.' }
  ] },
  { slug: 'last-stand', name: 'Last Stand', modes: [
    { slug: 'wave', name: 'Highest Wave', direction: 'desc', unit: 'points', min: 0, max: 10_000, description: 'Highest completed zombie wave.' }
  ] },
  { slug: 'invasion', name: 'Invasion', modes: [
    { slug: 'wave', name: 'Highest Wave', direction: 'desc', unit: 'points', min: 0, max: 10_000, description: 'Highest completed invasion wave.' }
  ] },
  { slug: 'survivor', name: 'Survivor', modes: [
    { slug: 'survival-time', name: 'Survival Time', direction: 'desc', unit: 'time', min: 0, max: 86_400, description: 'Longest community-submitted survival run.' }
  ] },
  { slug: 'light-cycles', name: 'Light Cycles', modes: [
    { slug: 'wins', name: 'Round Wins', direction: 'desc', unit: 'points', min: 0, max: 100_000, description: 'Completed local or online round wins.' }
  ] },
  { slug: 'planefight', name: 'Plane Fight', modes: [
    { slug: 'wins', name: 'Dogfight Wins', direction: 'desc', unit: 'points', min: 0, max: 100_000, description: 'Completed dogfight victories.' }
  ] },
  { slug: 'penguin-ninja', name: 'Penguin Ninja', modes: [
    { slug: 'distance', name: 'Longest Run', direction: 'desc', unit: 'points', min: 0, max: 100_000_000, description: 'Longest community-submitted parkour run.' }
  ] }
];

export function findMode(gameSlug, modeSlug) {
  const game = GAMES.find(item => item.slug === gameSlug);
  const mode = game?.modes.find(item => item.slug === modeSlug);
  return game && mode ? { game, mode } : null;
}
