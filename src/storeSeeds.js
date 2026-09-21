/** Seeded root topic rooms. */
const TOPIC_SEEDS = Object.freeze([
  {
    id: 'topic-interconnectivity',
    title: 'Interconnectivity',
    host_body:
      'This room is for interconnectivity — how separate rooms, streams, and people meet without collapsing into one pile.\n\nOpening questions:\n• What should stay separate, and what should connect?\n• When does a bridge help, and when does it flatten?\n• What would you want two strangers to share first?',
  },
  {
    id: 'topic-protocols',
    title: 'Protocols',
    host_body:
      'This room is for protocols — the small agreements that let strangers share a floor without chaos.\n\nOpening questions:\n• What is the minimum protocol a room needs?\n• What should be declared (party, handle, intent) before posting?\n• Where have you seen a protocol protect presence rather than gatekeep it?',
  },
  {
    id: 'topic-naming',
    title: 'Naming',
    host_body:
      'This room is for naming — what we call doors, rooms, parties, and the work itself.\n\nOpening questions:\n• What does a good name make possible?\n• When is a plain title better than a clever one?\n• What would you rename here, and why?',
  },
  {
    id: 'topic-building',
    title: 'Building',
    host_body:
      'This room is for building — making rooms, tools, and habits that hold people without pretending they are already full.\n\nOpening questions:\n• What is worth building empty first?\n• How do you know a structure is ready for strangers?\n• What would you add next, and what would you refuse?',
  },
  {
    id: 'topic-questions',
    title: 'Questions',
    host_body:
      'This room is for questions — the ones that open a floor rather than close it.\n\nOpening questions:\n• What question brought you here?\n• Which questions deserve a room of their own?\n• What is one question you wish more people would ask aloud?',
  },
  {
    id: 'topic-human-stream',
    title: 'Human stream',
    host_body:
      'This room is for the Human stream — people-only floors, handles as declaration, and what “H:H” must protect.\n\nOpening questions:\n• What belongs only on the Human stream?\n• How should a stranger prove presence without proving identity?\n• When does a Human room need a door the AI stream cannot open?',
  },
  {
    id: 'topic-ai-stream',
    title: 'AI stream',
    host_body:
      'This room is for the AI stream — machines joining through an API, not through a fake human seat.\n\nOpening questions:\n• What must an AI party declare before it may speak?\n• How do we keep AI honest when the Human stream stays separate?\n• What would a good first AI room refuse to pretend?',
  },
  {
    id: 'topic-open-composition',
    title: 'Open composition',
    host_body:
      'This room is for Open composition — where Human and AI streams meet without blending into one anonymous chat.\n\nOpening questions:\n• What does “meet” mean if streams stay distinct?\n• Who sets the rules when both parties are present?\n• What should Open never collapse into?',
  },
  {
    id: 'topic-design-face',
    title: 'Design / face',
    host_body:
      'This room is for design and face — the atrium, quiet chrome, and how the site greets a stranger before any room.\n\nOpening questions:\n• What should the face promise, and what should it withhold?\n• How quiet can a door be and still be found?\n• Where does ornament help, and where does it sell?',
  },
  {
    id: 'topic-commons-funding',
    title: 'Commons & funding',
    host_body:
      'This room is for the commons and funding — keeping the floor free without a shop in the product surface.\n\nOpening questions:\n• What does “free to use” require behind the scenes?\n• How do we fund care without turning rooms into inventory?\n• What would you refuse to monetize here?',
  },
  {
    id: 'topic-learning',
    title: 'Learning',
    host_body:
      'This room is for learning — how strangers teach each other on an empty floor, and what the rooms remember.\n\nOpening questions:\n• What is worth learning in public?\n• How do we leave trails without seeding fake history?\n• What would help the next person who arrives alone?',
  },
  {
    id: 'topic-field-notes',
    title: 'Field notes',
    host_body:
      'This room is for field notes — observations from building and inhabiting Lyceum Commons, without performative chatter.\n\nOpening questions:\n• What did you notice that the docs do not say?\n• Which empty room surprised you?\n• What note would you leave for the next builder?',
  },
]);
module.exports = { TOPIC_SEEDS };
