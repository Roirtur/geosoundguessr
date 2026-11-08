export type SoundCategory =
  'nature' | 'city' | 'music' | 'radio' | 'dialogue' | 'culture' | 'other';
export type ApprovalStatus = 'approved' | 'provisional' | 'rejected';
export type OriginType = 'recording_location' | 'cultural_origin' | 'broadcast_origin';
export type Phase = 'lobby' | 'preparing' | 'guessing' | 'results' | 'finished';
export interface Coordinates {
  latitude: number;
  longitude: number;
}
export interface SoundCandidate {
  id: string;
  provider: 'wikimedia' | 'openverse' | 'xeno-canto' | 'legacy-freesound';
  providerId: string;
  audioUrl: string;
  sourceUrl: string;
  title: string;
  description: string;
  creator: string;
  tags: string[];
  category: SoundCategory;
  duration?: number;
  latitude?: number;
  longitude?: number;
  countryCode?: string;
  countryName?: string;
  originType: OriginType;
  locationEvidence?: string;
  license: string;
  approvalStatus: ApprovalStatus;
  attribution: string;
  lastCheckedAt: string;
  playable: boolean;
  managedByAdmin?: boolean;
}
export type SoundEntry = Omit<
  SoundCandidate,
  keyof Coordinates | 'countryCode' | 'countryName' | 'playable'
> &
  Coordinates & {
    countryCode: string;
    countryName: string;
    playable: true;
  };
export interface PlayerView {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  isHost: boolean;
  confirmed: boolean;
  totalScore: number;
}
export interface GuessView extends Coordinates {
  playerId: string;
  countryName: string;
  distanceKm: number;
  score: number;
}
export interface RevealView {
  answer: Coordinates & { countryName: string; countryCode: string };
  sound: Pick<
    SoundEntry,
    | 'title'
    | 'category'
    | 'creator'
    | 'provider'
    | 'sourceUrl'
    | 'license'
    | 'attribution'
    | 'approvalStatus'
    | 'originType'
    | 'locationEvidence'
  >;
  guesses: GuessView[];
  skipped?: boolean;
}
export interface RoomView {
  code: string;
  phase: Phase;
  hostId: string;
  players: PlayerView[];
  roundCount: number;
  currentRound: number;
  serverNow: number;
  deadline?: number;
  preparationDeadline?: number;
  playbackUrl?: string;
  reveal?: RevealView;
  mode: 'casual' | 'curated';
  error?: string;
}
export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
export interface JoinResult {
  playerId: string;
  sessionToken: string;
  room: RoomView;
}
