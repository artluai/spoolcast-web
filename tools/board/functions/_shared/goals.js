export const goalDefinitions = [
  {
    id: 'cloud',
    title: 'Run hosted, from anywhere',
    summary:
      'Engine, rendering, and publishing all run in the cloud, so production works from any device and can scale past one Mac.',
  },
  {
    id: 'editor',
    title: 'Pipeline reliability',
    summary:
      'Every stage behaves: rules shape drafts and retry instead of refusing, buttons work, and early changes reach later steps. Autopilot amplifies every rough edge left here.',
  },
  {
    id: 'ingest',
    title: 'Writing in: manuscript to season plan',
    summary:
      'A writer feeds in their own long-form writing; Spoolcast indexes it, plans a season of episodes, and designs the cast and world once.',
  },
  {
    id: 'autopilot',
    title: 'Autopilot: hands-off production',
    summary:
      'A runner that chains the pipeline end to end under a budget, knows when an audit failure means retry, waive, or ask a human, and can batch a whole season.',
  },
  {
    id: 'show',
    title: 'Publish like a show',
    summary:
      'Finished episodes land on the site automatically with posters, durations, and episode order, on a series page that reads like a streaming show. Private work stays private.',
  },
  {
    id: 'money',
    title: 'Credits and creator earnings',
    summary:
      'Viewers spend credits to watch past the free episodes; creators earn a share. Needs signed media URLs, the unlock ledger, and Stripe.',
  },
  {
    id: 'founder',
    title: 'Founder decisions',
    summary: 'Calls only Ralph can make: spend caps, pricing, licenses, and accounts.',
  },
];

export const goalIds = goalDefinitions.map(({ id }) => id);
