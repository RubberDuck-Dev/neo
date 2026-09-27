"use strict";

// English-specific rules; do not run on other manuscript languages.
const REVISION_ECHO_WINDOW = 40; // words
const REVISION_STOP = new Set(("a about above after again against all almost also although always am an and another any " +
  "are around as at back be because been before being below between both but by came can come could did do does doing done down " +
  "during each even ever every few for from get got had has have having he her here hers herself him himself his how i if in into " +
  "is it its itself just know like made make many may me might more most much must my myself never no nor not now of off on once " +
  "one only or other our ours out over own said same say says see she should so some still such than that the their theirs them " +
  "themselves then there these they thing things this those though through to too under until up upon us very was way we well were " +
  "what when where which while who whom why will with would yes yet you your yours yourself back look looked away eyes going went " +
  "into onto").split(" "));
const REVISION_FILLER = ["just", "really", "very", "quite", "rather", "somewhat", "actually", "basically", "literally",
  "suddenly", "simply", "totally", "completely", "definitely", "certainly", "truly", "seemingly", "began to", "started to",
  "seemed to", "sort of", "kind of", "a bit", "a little", "in order to"];
const REVISION_NOT_ADVERB = new Set(("only family early reply apply supply fly belly bully jelly rally ally holy ugly lovely " +
  "lonely friendly lively likely unlikely daily weekly monthly yearly hourly nightly silly chilly hilly curly burly surly costly " +
  "deadly elderly orderly oily woolly wily jolly folly holly lily sly butterfly dragonfly assembly anomaly italy july rely comply " +
  "imply multiply homily doily melancholy dally sully tally gully july emily molly sally kelly billy reilly ally gangly ghastly " +
  "ghostly godly heavenly homely kindly leisurely manly motherly fatherly brotherly sisterly neighborly portly prickly queenly " +
  "saintly scholarly shapely sickly smelly stately timely ugly unruly wobbly wrinkly bubbly cuddly giggly grisly grizzly " +
  "measly miserly niggardly northerly southerly easterly westerly pearly poly rascally squiggly steely stingy scaly bodily").split(" "));

