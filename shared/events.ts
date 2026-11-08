export const EVENTS = {
  roomState: 'room:state',
  create: 'room:create',
  join: 'room:join',
  resume: 'room:resume',
  leave: 'room:leave',
  configure: 'room:configure',
  start: 'game:start',
  ready: 'audio:ready',
  audioFailed: 'audio:failed',
  confirm: 'guess:confirm',
  advance: 'game:advance',
  playAgain: 'game:again',
} as const;
