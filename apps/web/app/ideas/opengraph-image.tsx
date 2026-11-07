import { IDEAS_CARD_ALT, CARD_SIZE, ideasCard } from "../../lib/idea-card.tsx";
import { listIdeas } from "../../lib/ideas.ts";

export const alt = IDEAS_CARD_ALT;
export const size = CARD_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ideasCard(listIdeas());
}
