// ---------------------------------------------------------------------------
// VeriCall core types & wire protocol.
//
// This file is part of Layer 1 (Core). It has ZERO knowledge of Chrome, the
// DOM, or any specific calling platform. The same types are used by the relay
// server and by every future adapter (Zoom, Teams, standalone app).
// ---------------------------------------------------------------------------

/** Verification state for a single remote participant, as shown on the badge. */
export type VerificationState = 'unknown' | 'verified' | 'unverified' | 'stale';

/**
 * The payload that is hashed + signed for every video snapshot.
 * `hash` is the SHA-256 of the captured frame, hex-encoded.
 */
export interface SignedPayload {
  counter: number;
  timestamp: number; // ms since epoch (signer's clock)
  hash: string; // hex SHA-256 of the frame bytes
}

// --- Relay wire messages ---------------------------------------------------
// The relay forwards these opaquely between the two participants that share a
// session code. It never inspects crypto fields — see server/index.ts.

/** Client → server: join (or create) a session. */
export interface JoinMessage {
  type: 'join';
  session: string;
  participantId: string;
}

/** Server → client: another participant is present in the session. */
export interface PeerJoinedMessage {
  type: 'peer-joined';
  participantId: string;
}

/** Server → client: a participant left the session. */
export interface PeerLeftMessage {
  type: 'peer-left';
  participantId: string;
}

/** Either direction: announce/relay a participant's public key. */
export interface PublicKeyMessage {
  type: 'pubkey';
  from: string;
  publicKeyJwk: JsonWebKey;
}

/** Either direction: a signed snapshot of the sender's outgoing video. */
export interface SignedFrameMessage {
  type: 'signed-frame';
  from: string;
  counter: number;
  timestamp: number;
  hash: string;
  /** base64-encoded raw ECDSA signature. */
  signature: string;
}

/** Server → client: sent right after joining, before any peer is present. */
export interface JoinedMessage {
  type: 'joined';
  session: string;
  /** participantIds already in the session (excluding you). */
  peers: string[];
}

/** Server → client: an error (e.g. session full). */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ClientMessage =
  | JoinMessage
  | PublicKeyMessage
  | SignedFrameMessage;

export type ServerMessage =
  | JoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | PublicKeyMessage
  | SignedFrameMessage
  | ErrorMessage;

/** Any message that travels on the relay socket. */
export type RelayMessage = ClientMessage | ServerMessage;
