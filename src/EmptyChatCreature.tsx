import { useState, type ComponentType } from "react";
import EmptyChatCrab from "./EmptyChatCrab";
import EmptyChatLlama from "./EmptyChatLlama";
import EmptyChatOwl from "./EmptyChatOwl";
import EmptyChatRobot from "./EmptyChatRobot";
import EmptyChatSnail from "./EmptyChatSnail";
import EmptyChatWhale from "./EmptyChatWhale";
import { type Creature, pickCreature } from "./suggestions";

const COMPONENTS: Record<Creature, ComponentType> = {
  whale: EmptyChatWhale,
  llama: EmptyChatLlama,
  snail: EmptyChatSnail,
  robot: EmptyChatRobot,
  owl: EmptyChatOwl,
  crab: EmptyChatCrab,
};

// The creature above the empty chat's message, chosen when the empty screen
// appears: this mounts with it, so typing doesn't reshuffle it.
export default function EmptyChatCreature() {
  const [creature] = useState(() => pickCreature());
  const Creature = COMPONENTS[creature];
  return <Creature />;
}
