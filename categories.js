// Question bank grouped by type to make adding more questions easier.
// normal => white questions in the UI.
const QUESTION_BANK = {
  normal: [
    "Holiday Activities",
    "Ways to Kill Time",
    "Reasons to Call 911",
    "Things That Have Buttons",
    "Things That Have Wheels",
    "Types of Shoes",
    "Types of Weather",
    "Reasons to Make a Phone Call",
    "Things You Save Up to Buy",
    "Things You Get in the Mail",
    "Things You Do Every Day",
    "Things You Store Items In",
    "Items on Your Office Desk",
    "Words Associated with Winter",
    "Reasons to Take Out a Loan",
    "Honeymoon Spots",
    "Bucket List Items",
    "Places to Hang Out",
    "Types of Drinks",
    "Cartoon Characters",
    "States",
    "Things at the Circus",
    "Beers",
    "Types of Bags",
    "Things at a Football Game",
    "Things You Do at Work",
    "Words Associated with Money",
    "Famous Duos or Trios",
    "Things You Shout",
    "Things You Replace",
    "Things You Make",
    "Things You Shouldn’t Touch",
    "Store Names",
    "Girls’ Names",
    "Flowers",
    "Parts of the Body",
    "Song Titles",
    "Qualities of <Name>",
    "Things That Are Round",
    "Movies with IMDb Rating Below 5",
    "Toys",
    "Restaurants",
    "Celebrities",
    "Bad Habits",
    "Items in This Room",
    "Nicknames",
    "Things in a Park",
    "Excuses for Being Late",
    "Movie Characters",
    "Athletes",
    "F1 Teams",
    "Boys’ Names",
    "Something You Love",
    "Items You Take to the Gym",
    "Beverages",
    "Things That Smell Bad",
    "Bollywood Actors or Actresses",
    "Things That Are Black",
    "Dairy Products",
    "Diseases",
    "Things You Throw Away",
    "Gifts",
    "Languages",
    "Fruits",
    "Words Ending in “N”",
    "Farm Animals",
    "Breakfast Foods",
    "Famous Females",
    "Items in a Suitcase",
    "Things That Spin",
    "Famous Singers",
    "Accessories",
    "Things You’re Afraid Of",
    "Things on a Beach",
    "Superheroes",
    "Offensive Words",
    "Product Names",
    "Vegetables",
    "Things That Are Cold",
    "Villains or Monsters",
    "Things You’re Allergic To",
    "Things That Grow",
    "Things You See at the Zoo",
    "Sports Played Indoors or Outdoors",
    "Anime Characters or Anime",
    "Electronics Companies",
    "Cricketers",
    "Appliances",
    "YouTubers",
    "Expensive or Luxury Items",
    "Four-Letter Words",
    "Hobbies",
    "Snack Foods",
    "<Name>’s Guilty Pleasure",
    "Clothing",
    "SRK or Akshay Kumar Movies",
    "Colours",
    "Words Ending in “-ing”",
    "Apps",
    "Birds",
    "Things in the Fridge",
    "Countries",
    "Types of Cheese",
    "Stones or Gems",
    "Video Games",
    "Items Under $10",
    "Things in the Sky",
    "Disney Characters",
    "Currencies",
    "Words with the Vowel “A”",
    "Condom Flavours",
    "Stationery Items",
    "Healthy Foods",
    "Alcohol Brands",
    "Comedy Movies",
    "Things You Do Alone",
    "Things That Move Fast",
    "Hollywood Actors",
    "Tools",
    "Things That Are Red",
    "Sea Animals or Seafood",
    "Romantic Places",
    "Famous Eateries",
    "Freedom Fighters",
    "Indian Youth Names",
    "Items That Contain Salt",
    "Anything Related to Goa",
    "Things Carried on a Picnic",
    "Bad-Quality Traits in a Person Next to You",
    "Things That Make Sound",
    "FMCG Stores or Companies",
    "DC or Marvel Characters",
    "Coastal Places or Cities",
    "Things in a Grocery Store",
    "European Countries",
    "Leisure Activities",
    "Electronic Appliances or Devices",
    "Reasons to Quit a Job",
    "Reasons You Want to Die",
    "Famous Books",
    "<Name>’s Favourite Free-Time Activity",
    "Role Models or Influencers"
  ],
  blue: [
    "Things That Make You Smile",
    "Occupations",
    "Things That Are Sticky",
    "Dog Breeds",
    "Furniture",
    "Things You Buy for Kids",
    "Shopping Brands",
    "Fictional Characters",
    "Listed Companies",
    "TV Shows",
    "Types of Superpowers",
    "Phone Brands",
    "Things Found at a Party",
    "Things That Can Kill You",
    "Sports Teams",
    "Things Associated with Gujaratis",
    "Amitabh or Salman Movies",
    "Something related to speed",
    "Something you blame others for",
  ],
  red: [
    "Items You Take on a Trip",
    "Mobile or Video Games",
    "<Name>’s Toxic Trait",
    "<Name>’s Favourite Food",
    "Animals You Can Pet",
    "First thing you notice about <Name>",
    "Something you like about <Name>",
    "Something you often lose",
    "Items in a Vending Machine",
    "Pizza Toppings",
    "School Subjects",
    "<Name>’s Pet Peeve",
    "What <Name> Will Spend Too Much Money On",
    "If Not the Current Career, What <Name> Might Do",
    "Netflix Series",
    "Things <Name> Can’t Live Without",
    "<Name>’s Favourite Weapon",
    "What <Name> Is Scared Of",
    "<Name>’s Weird Habit",
    "Things you plug in"
  ],
  green: [
    "Things That Will Get You Fired",
    "Movie Titles",
    "Something You Keep Hidden",
    "Words with Three Different Vowels",
    "Things to Do on a Date",
    "Items in a Kitchen",
    "Ice Cream Flavours",
    "Things That Jump or Bounce",
    "Sugary Items",
    "Railway Station Names",
    "Mythological Persons or Creatures",
    "Spices or Herbs",
    "Sounds Animals Make",
    "Indian Foods",
    "Gujarati Foods",
    "Word that is easy to misspell",
    "Things you regret",
    "Things <name> won’t share with others",

  ]
};

// Letters used for rounds (excludes Q, X, Z)
const LETTERS = [
  "A", "B", "C", "D", "E", "F", "G",
  "H", "I", "J", "K", "L", "M", "N",
  "O", "P", "R", "S", "T", "U", "V",
  "W", "Y"
];

function randomLetter() {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// For each round: 9 normal (white), 1 blue, 1 red, 1 green
function getCategoriesForRound(roundIndex) {
  const normalShuffled = shuffle(QUESTION_BANK.normal);
  const blueShuffled = shuffle(QUESTION_BANK.blue);
  const redShuffled = shuffle(QUESTION_BANK.red);
  const greenShuffled = shuffle(QUESTION_BANK.green);

  const selected = [];
  normalShuffled.slice(0, 9).forEach((name) => selected.push({ name, type: "white" }));
  blueShuffled.slice(0, 1).forEach((name) => selected.push({ name, type: "blue" }));
  redShuffled.slice(0, 1).forEach((name) => selected.push({ name, type: "red" }));
  greenShuffled.slice(0, 1).forEach((name) => selected.push({ name, type: "green" }));

  // Shuffle final order so special colors aren't always at the bottom.
  return shuffle(selected);
}

module.exports = {
  getCategoriesForRound,
  randomLetter,
  QUESTION_BANK,
  LETTERS
};
