'use strict';

/*
  Promo codes verified in the installed game files.

  Collapse! (2010) stores these two strings back-to-back in collapse.exe, next
  to its Redeem Codes UI strings. The game is case-insensitive for promo-code
  input; the values are kept lowercase and displayed exactly as copied.

  The other Paris/Pirate/Clown strings in this collection belong to puzzle
  themes, avatar names, or puzzle artwork. They are not redeem codes, so they
  are deliberately not listed here.
*/
const GAME_CODES = {
  collapse: [
    { code: 'eindhoven', reward: 'Clown outfit', source: 'collapse.exe' },
    { code: 'paris', reward: 'Pirate outfit', source: 'collapse.exe' },
  ],
};

const CODE_GUIDES = {
  collapse: {
    where: 'In Collapse!, open the Redeem Codes screen and enter the code.',
    search: 'Game-file search: these two promo-code strings are stored beside the Redeem Codes UI in collapse.exe. No other promo-code entries were found in the installed games; the other Paris, Pirate, and Clown matches are puzzle or avatar names.',
  },
};

module.exports = { GAME_CODES, CODE_GUIDES };
