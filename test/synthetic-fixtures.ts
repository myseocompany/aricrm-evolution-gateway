/**
 * Synthetic conversation fixtures for ARI Pulse analyzer validation.
 *
 * Every conversation is fabricated — no real data, no PII.
 * Each case records the expected detection result under SILENCE_THRESHOLD_MINUTES.
 */

// Analyzer contract types

export type Direction = 'in' | 'out';
export type Actor = 'customer' | 'unknown' | 'automation';
export type Category = 'unanswered' | 'answered' | 'delayed-response' | 'ambiguous';

export interface Message {
  timestamp: string;
  direction: Direction;
  actor: Actor;
  text: string;
}

export interface Conversation {
  conversation_id: string;
  messages: Message[];
}

export interface ExpectedDetection {
  candidate: boolean;
  signals: string[];
  last_direction: Direction | null;
  first_response_minutes: number | null;
  max_inbound_wait_minutes: number | null;
  message_count: number;
}

export interface SyntheticFixture {
  id: string;
  category: Category;
  description: string;
  conversation: Conversation;
  expected: ExpectedDetection;
}

/** Silence threshold in minutes — matches the analyzer default from analyze.py. */
export const SILENCE_THRESHOLD_MINUTES = 15;

const fixtures: SyntheticFixture[] = [

  {
    id: 'syn-unanswered-001',
    category: 'unanswered',
    description: 'Customer sends one message, no response at all',
    conversation: {
      conversation_id: 'syn-unanswered-001',
      messages: [
        { timestamp: '2026-10-01T18:00:00Z', direction: 'in', actor: 'customer', text: 'Hola, quiero hacer un pedido' },
      ],
    },
    expected: {
      candidate: true,
      signals: ['unanswered_inbound'],
      last_direction: 'in',
      first_response_minutes: null,
      max_inbound_wait_minutes: null,
      message_count: 1,
    },
  },

  {
    id: 'syn-answered-001',
    category: 'answered',
    description: 'Customer asks, agent replies in 5 min (under threshold)',
    conversation: {
      conversation_id: 'syn-answered-001',
      messages: [
        { timestamp: '2026-10-01T18:00:00Z', direction: 'in', actor: 'customer', text: '¿Cuál es el menú del día?' },
        { timestamp: '2026-10-01T18:05:00Z', direction: 'out', actor: 'unknown', text: 'Hoy tenemos sancocho y tacos' },
      ],
    },
    expected: {
      candidate: false,
      signals: [],
      last_direction: 'out',
      first_response_minutes: 5,
      max_inbound_wait_minutes: 5,
      message_count: 2,
    },
  },

  {
    id: 'syn-delayed-001',
    category: 'delayed-response',
    description: 'Customer asks, agent replies after 25 min (over threshold)',
    conversation: {
      conversation_id: 'syn-delayed-001',
      messages: [
        { timestamp: '2026-10-01T18:00:00Z', direction: 'in', actor: 'customer', text: 'Necesito una cotización para 50 porciones' },
        { timestamp: '2026-10-01T18:25:00Z', direction: 'out', actor: 'unknown', text: 'Con gusto, le envío la cotización' },
      ],
    },
    expected: {
      candidate: true,
      signals: ['response_gap_over_threshold'],
      last_direction: 'out',
      first_response_minutes: 25,
      max_inbound_wait_minutes: 25,
      message_count: 2,
    },
  },

  {
    id: 'syn-ambiguous-001',
    category: 'ambiguous',
    description: 'Customer sends 3 messages, agent replies once after 20 min, no further reply',
    conversation: {
      conversation_id: 'syn-ambiguous-001',
      messages: [
        { timestamp: '2026-10-01T17:00:00Z', direction: 'in', actor: 'customer', text: 'Buenas tardes' },
        { timestamp: '2026-10-01T17:01:00Z', direction: 'in', actor: 'customer', text: 'Quiero información del catering' },
        { timestamp: '2026-10-01T17:02:00Z', direction: 'in', actor: 'customer', text: 'Para un evento el sábado' },
        { timestamp: '2026-10-01T17:20:00Z', direction: 'out', actor: 'unknown', text: 'Un momento, le paso la info' },
      ],
    },
    expected: {
      candidate: true,
      signals: ['response_gap_over_threshold'],
      last_direction: 'out',
      first_response_minutes: 20,
      max_inbound_wait_minutes: 20,
      message_count: 4,
    },
  },

  {
    id: 'syn-ambiguous-002',
    category: 'ambiguous',
    description: 'Customer asks, agent replies, customer follows up — no second reply',
    conversation: {
      conversation_id: 'syn-ambiguous-002',
      messages: [
        { timestamp: '2026-10-01T19:00:00Z', direction: 'in', actor: 'customer', text: '¿Tienen disponibilidad para el viernes?' },
        { timestamp: '2026-10-01T19:03:00Z', direction: 'out', actor: 'unknown', text: 'Sí, ¿para cuántas personas?' },
        { timestamp: '2026-10-01T19:04:00Z', direction: 'in', actor: 'customer', text: 'Para 30 personas, ¿cuál es el precio?' },
      ],
    },
    expected: {
      candidate: true,
      signals: ['unanswered_inbound'],
      last_direction: 'in',
      first_response_minutes: 3,
      max_inbound_wait_minutes: 3,
      message_count: 3,
    },
  },
];

export { fixtures };
