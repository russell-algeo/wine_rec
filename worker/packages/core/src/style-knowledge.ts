/**
 * General wine-style knowledge for rule-based taste inference when no
 * provider profile is available. Built from general wine knowledge (grapes,
 * appellations, styles), not from any particular menu. Taste values are
 * 1–5 for body, acidity, tannin and sweetness.
 */
export type StyleVector = { body: number; acidity: number; tannin: number; sweetness: number };

export const STYLE_VECTORS: Record<string, StyleVector> = {
  // whites
  sauvignon_blanc: { body: 2, acidity: 5, tannin: 1, sweetness: 1 },
  crisp_white: { body: 2, acidity: 5, tannin: 1, sweetness: 1 },
  light_white: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  riesling_dry: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  riesling_sweet: { body: 2, acidity: 4, tannin: 1, sweetness: 4 },
  chardonnay: { body: 3, acidity: 3, tannin: 1, sweetness: 1 },
  chardonnay_unoaked: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  chenin_blanc: { body: 3, acidity: 4, tannin: 1, sweetness: 2 },
  pinot_grigio: { body: 2, acidity: 3, tannin: 1, sweetness: 1 },
  aromatic_white: { body: 3, acidity: 3, tannin: 1, sweetness: 2 },
  full_white: { body: 4, acidity: 2, tannin: 1, sweetness: 1 },
  medium_white: { body: 3, acidity: 3, tannin: 1, sweetness: 1 },
  // reds
  light_red: { body: 2, acidity: 4, tannin: 2, sweetness: 1 },
  pinot_noir: { body: 3, acidity: 4, tannin: 2, sweetness: 1 },
  medium_red: { body: 3, acidity: 4, tannin: 3, sweetness: 1 },
  cabernet_sauvignon: { body: 4, acidity: 3, tannin: 4, sweetness: 1 },
  merlot: { body: 4, acidity: 3, tannin: 3, sweetness: 1 },
  syrah: { body: 4, acidity: 3, tannin: 4, sweetness: 1 },
  grenache: { body: 4, acidity: 3, tannin: 3, sweetness: 1 },
  tempranillo: { body: 4, acidity: 3, tannin: 3, sweetness: 1 },
  malbec: { body: 4, acidity: 3, tannin: 4, sweetness: 1 },
  nebbiolo: { body: 4, acidity: 5, tannin: 5, sweetness: 1 },
  sangiovese: { body: 3, acidity: 4, tannin: 4, sweetness: 1 },
  barbera: { body: 3, acidity: 5, tannin: 2, sweetness: 1 },
  zinfandel: { body: 5, acidity: 3, tannin: 3, sweetness: 1 },
  big_tannic_red: { body: 5, acidity: 3, tannin: 5, sweetness: 1 },
  amarone: { body: 5, acidity: 3, tannin: 3, sweetness: 2 },
  // rosé, sparkling, orange
  rose_dry: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  champagne: { body: 3, acidity: 5, tannin: 1, sweetness: 1 },
  prosecco: { body: 2, acidity: 4, tannin: 1, sweetness: 2 },
  default_sparkling: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  sparkling_red: { body: 3, acidity: 4, tannin: 2, sweetness: 2 },
  sweet_sparkling: { body: 1, acidity: 3, tannin: 1, sweetness: 4 },
  orange_wine: { body: 3, acidity: 4, tannin: 2, sweetness: 1 },
  // sweet and fortified
  dessert_white: { body: 4, acidity: 4, tannin: 1, sweetness: 5 },
  port_ruby: { body: 5, acidity: 3, tannin: 3, sweetness: 5 },
  port_tawny: { body: 4, acidity: 3, tannin: 1, sweetness: 5 },
  madeira: { body: 4, acidity: 4, tannin: 1, sweetness: 4 },
  sherry_fino: { body: 2, acidity: 3, tannin: 1, sweetness: 1 },
  sherry_amontillado: { body: 3, acidity: 3, tannin: 1, sweetness: 1 },
  sherry_oloroso: { body: 4, acidity: 2, tannin: 1, sweetness: 1 },
  sherry_sweet: { body: 5, acidity: 2, tannin: 1, sweetness: 5 },
  // sake and plum wine
  sake: { body: 2, acidity: 2, tannin: 1, sweetness: 2 },
  sake_nigori: { body: 3, acidity: 2, tannin: 1, sweetness: 4 },
  sake_sparkling: { body: 2, acidity: 3, tannin: 1, sweetness: 3 },
  umeshu: { body: 3, acidity: 3, tannin: 1, sweetness: 5 },
  // colour fallbacks
  default_white: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  default_red: { body: 4, acidity: 3, tannin: 3, sweetness: 1 },
};

type Entry = [aliases: string[], key: string, alt?: { white?: string; red?: string }];

/** Grape varieties (and common synonyms). */
export const GRAPES: Entry[] = [
  [["sauvignon blanc", "fume blanc", "sauvignon"], "sauvignon_blanc"],
  [["cabernet sauvignon", "cabernet"], "cabernet_sauvignon"],
  [["cabernet franc", "cab franc", "bouchet"], "medium_red"],
  [["merlot"], "merlot"],
  [["pinot noir", "spatburgunder", "pinot nero", "blauburgunder"], "pinot_noir"],
  [["pinot grigio", "pinot gris", "grauburgunder"], "pinot_grigio"],
  [["pinot blanc", "pinot bianco", "weissburgunder"], "light_white"],
  [["pinot meunier", "meunier"], "pinot_noir"],
  [["chardonnay"], "chardonnay"],
  [["riesling"], "riesling_dry"],
  [["chenin blanc", "chenin", "steen"], "chenin_blanc"],
  [["verdelho"], "medium_white"],
  [["syrah", "shiraz"], "syrah"],
  [["petite sirah", "petite syrah", "durif"], "big_tannic_red"],
  [["grenache", "garnacha", "cannonau", "garnatxa"], "grenache"],
  [["monica di sardegna"], "medium_red"],
  [["grenache blanc", "garnacha blanca"], "full_white"],
  [["tempranillo", "tinto fino", "tinta de toro", "tinta roriz", "aragonez", "ull de llebre"], "tempranillo"],
  [["malbec", "cot"], "malbec"],
  [["nebbiolo", "spanna", "chiavennasca"], "nebbiolo"],
  [["sangiovese", "brunello", "prugnolo gentile", "morellino"], "sangiovese"],
  [["barbera"], "barbera"],
  [["dolcetto"], "medium_red"],
  [["zinfandel", "primitivo"], "zinfandel"],
  [["gamay"], "light_red"],
  [["mourvedre", "monastrell", "mataro"], "big_tannic_red"],
  [["carignan", "carignano", "carinena", "mazuelo", "samso"], "medium_red"],
  [["cinsault", "cinsaut"], "light_red"],
  [["carmenere"], "merlot"],
  [["tannat"], "big_tannic_red"],
  [["aglianico"], "big_tannic_red"],
  [["sagrantino"], "big_tannic_red"],
  [["montepulciano"], "merlot"],
  [["nero d avola", "calabrese"], "merlot"],
  [["nerello mascalese", "nerello"], "medium_red"],
  [["frappato"], "light_red"],
  [["corvina", "corvinone", "rondinella"], "medium_red"],
  [["lagrein"], "merlot"],
  [["teroldego"], "merlot"],
  [["schiava", "vernatsch", "trollinger"], "light_red"],
  [["refosco"], "medium_red"],
  [["mencia"], "medium_red"],
  [["bobal"], "merlot"],
  [["graciano"], "medium_red"],
  [["touriga nacional", "touriga franca", "touriga"], "syrah"],
  [["baga"], "nebbiolo"],
  [["alicante bouschet", "garnacha tintorera"], "big_tannic_red"],
  [["castelao", "periquita"], "medium_red"],
  [["trincadeira", "tinta amarela"], "medium_red"],
  [["jaen"], "medium_red"],
  [["pinotage"], "merlot"],
  [["xinomavro"], "nebbiolo"],
  [["agiorgitiko"], "merlot"],
  [["mavrodaphne"], "medium_red"],
  [["blaufrankisch", "lemberger", "kekfrankos"], "medium_red"],
  [["zweigelt"], "light_red"],
  [["st laurent", "sankt laurent", "saint laurent"], "pinot_noir"],
  [["poulsard", "ploussard", "trousseau"], "light_red"],
  [["saperavi"], "big_tannic_red"],
  [["mavrud"], "medium_red"],
  [["plavac mali"], "big_tannic_red"],
  [["lambrusco"], "sparkling_red"],
  [["gruner veltliner", "gruner", "gruener veltliner"], "crisp_white"],
  [["albarino", "alvarinho"], "crisp_white"],
  [["assyrtiko"], "crisp_white"],
  [["muscadet", "melon de bourgogne"], "crisp_white"],
  [["picpoul", "piquepoul"], "crisp_white"],
  [["txakoli", "txakolina", "hondarrabi zuri"], "crisp_white"],
  [["verdejo"], "crisp_white"],
  [["vermentino", "rolle", "pigato", "favorita"], "light_white"],
  [["verdicchio"], "light_white"],
  [["garganega"], "light_white"],
  [["cortese"], "light_white"],
  [["arneis"], "medium_white"],
  [["fiano"], "medium_white"],
  [["greco"], "medium_white"],
  [["falanghina"], "light_white"],
  [["trebbiano", "ugni blanc"], "light_white"],
  [["friulano", "tocai friulano", "sauvignonasse"], "light_white"],
  [["ribolla gialla", "ribolla", "rebula"], "light_white"],
  [["godello"], "medium_white"],
  [["xarel lo", "xarello", "macabeo", "viura", "parellada"], "light_white"],
  [["aligote"], "crisp_white"],
  [["sylvaner", "silvaner"], "light_white"],
  [["furmint"], "crisp_white"],
  [["harslevelu"], "medium_white"],
  [["semillon"], "medium_white"],
  [["marsanne", "roussanne"], "full_white"],
  [["viognier"], "aromatic_white"],
  [["gewurztraminer", "traminer", "gewurz"], "aromatic_white"],
  [["muscat", "moscato", "moscatel", "muskateller", "muscadelle"], "aromatic_white"],
  [["torrontes"], "aromatic_white"],
  [["moschofilero"], "aromatic_white"],
  [["malagousia", "malagouzia"], "aromatic_white"],
  [["savatiano", "roditis", "robola", "vidiano", "athiri"], "light_white"],
  [["malvasia", "malvazija", "malmsey"], "aromatic_white"],
  [["loureiro", "arinto", "encruzado", "fernao pires", "antao vaz", "avesso"], "light_white"],
  [["listan blanco", "palomino"], "light_white"],
  [["listan negro", "listan prieto"], "light_red"],
  [["savagnin"], "medium_white"],
  [["chasselas", "fendant"], "light_white"],
  [["petit manseng", "gros manseng"], "aromatic_white"],
  [["koshu"], "light_white"],
  [["albillo", "albillo real", "dona blanca", "merseguera", "hondarribi"], "light_white"],
  [["timorasso", "pecorino", "passerina", "grillo", "catarratto", "inzolia", "carricante", "nascetta"], "medium_white"],
  [["colombard"], "light_white"],
  [["welschriesling", "grasevina", "olaszrizling"], "light_white"],
];

/** Appellations and regions with their dominant style; alt applies a colour word. */
export const APPELLATIONS: Entry[] = [
  // France
  [["chablis"], "chardonnay_unoaked"],
  [["meursault", "puligny montrachet", "chassagne montrachet", "corton charlemagne", "montrachet", "pouilly fuisse", "macon", "maconnais", "saint veran", "st veran", "vire clesse", "saint aubin", "st aubin"], "chardonnay", { red: "pinot_noir" }],
  [["bourgogne", "burgundy", "cote de nuits", "cote de beaune", "gevrey chambertin", "chambolle musigny", "vosne romanee", "nuits saint georges", "nuits st georges", "morey saint denis", "morey st denis", "pommard", "volnay", "santenay", "marsannay", "fixin", "savigny les beaune", "beaune", "mercurey", "givry", "rully", "aloxe corton", "clos de vougeot", "richebourg", "chambertin", "musigny", "echezeaux", "la tache", "romanee", "irancy"], "pinot_noir", { white: "chardonnay" }],
  [["beaujolais", "morgon", "fleurie", "moulin a vent", "brouilly", "cote de brouilly", "julienas", "chiroubles", "chenas", "regnie", "saint amour"], "light_red"],
  [["bordeaux", "medoc", "haut medoc", "pauillac", "margaux", "saint julien", "st julien", "saint estephe", "st estephe", "pessac leognan", "graves", "listrac", "moulis"], "cabernet_sauvignon", { white: "sauvignon_blanc" }],
  [["saint emilion", "st emilion", "pomerol", "fronsac", "lalande de pomerol", "castillon", "cotes de bourg", "blaye"], "merlot", { white: "sauvignon_blanc" }],
  [["entre deux mers"], "sauvignon_blanc"],
  [["sauternes", "barsac", "loupiac", "cadillac", "monbazillac", "coteaux du layon", "bonnezeaux", "quarts de chaume", "jurancon"], "dessert_white"],
  [["sancerre", "pouilly fume", "menetou salon", "quincy", "reuilly", "touraine"], "sauvignon_blanc", { red: "pinot_noir" }],
  [["vouvray", "montlouis", "savennieres", "anjou blanc", "saumur blanc"], "chenin_blanc"],
  [["chinon", "bourgueil", "saint nicolas de bourgueil", "saumur champigny", "saumur"], "medium_red", { white: "chenin_blanc" }],
  [["muscadet sevre et maine"], "crisp_white"],
  [["alsace"], "aromatic_white"],
  [["cote rotie", "hermitage", "crozes hermitage", "saint joseph", "st joseph", "cornas"], "syrah", { white: "full_white" }],
  [["condrieu", "chateau grillet"], "aromatic_white"],
  [["chateauneuf du pape", "chateauneuf", "gigondas", "vacqueyras", "rasteau", "cairanne", "lirac", "cotes du rhone", "cote du rhone", "rhone", "ventoux", "costieres de nimes", "luberon"], "grenache", { white: "full_white" }],
  [["tavel"], "rose_dry"],
  [["bandol"], "big_tannic_red", { white: "medium_white" }],
  [["provence", "cotes de provence", "coteaux d aix"], "rose_dry", { red: "grenache", white: "light_white" }],
  [["languedoc", "pic saint loup", "minervois", "corbieres", "faugeres", "saint chinian", "fitou", "terrasses du larzac", "roussillon", "cotes du roussillon", "collioure"], "grenache", { white: "full_white" }],
  [["cahors", "madiran", "irouleguy"], "big_tannic_red"],
  [["jura", "arbois", "cotes du jura"], "medium_white", { red: "light_red" }],
  [["vin jaune", "chateau chalon"], "sherry_fino"],
  [["savoie", "jacquere", "apremont"], "light_white", { red: "light_red" }],
  [["champagne", "blanc de blancs", "blanc de noirs", "epernay", "reims", "ambonnay", "bouzy", "cramant", "avize", "le mesnil sur oger", "mesnil sur oger", "ay champagne", "aube", "cote des bar"], "champagne"],
  [["cremant"], "default_sparkling"],
  [["banyuls", "maury", "rivesaltes"], "port_ruby"],
  [["muscat de beaumes de venise", "beaumes de venise"], "dessert_white"],
  // Italy
  [["barolo", "barbaresco", "roero", "gattinara", "ghemme", "langhe nebbiolo", "valtellina", "sforzato"], "nebbiolo"],
  [["chianti", "chianti classico", "vino nobile di montepulciano", "vino nobile", "rosso di montalcino", "brunello di montalcino", "montalcino", "carmignano", "morellino di scansano"], "sangiovese"],
  [["bolgheri", "super tuscan", "toscana igt"], "cabernet_sauvignon"],
  [["toscana", "tuscany"], "sangiovese", { white: "light_white" }],
  [["amarone"], "amarone"],
  [["valpolicella", "ripasso", "bardolino"], "medium_red"],
  [["recioto", "vin santo", "passito", "moscato d asti"], "dessert_white"],
  [["soave", "lugana", "gavi", "orvieto", "frascati", "est est est"], "light_white"],
  [["etna rosso"], "medium_red"],
  [["etna bianco"], "medium_white"],
  [["etna"], "medium_red", { white: "medium_white" }],
  [["taurasi"], "big_tannic_red"],
  [["montepulciano d abruzzo"], "merlot"],
  [["cerasuolo di vittoria"], "light_red"],
  [["alto adige", "sudtirol", "friuli", "collio"], "light_white", { red: "medium_red" }],
  [["franciacorta", "trento doc", "trentodoc", "alta langa", "spumante"], "champagne"],
  [["prosecco", "conegliano", "valdobbiadene"], "prosecco"],
  [["marsala"], "madeira"],
  // Spain
  [["rioja", "rioja alta", "rioja alavesa"], "tempranillo", { white: "medium_white" }],
  [["ribera del duero", "toro", "cigales"], "tempranillo"],
  [["priorat", "priorato", "montsant", "campo de borja", "calatayud", "terra alta"], "grenache", { white: "full_white" }],
  [["rias baixas"], "crisp_white"],
  [["rueda"], "crisp_white"],
  [["bierzo", "ribeira sacra"], "medium_red", { white: "medium_white" }],
  [["valdeorras"], "medium_white"],
  [["jumilla", "yecla", "alicante"], "big_tannic_red"],
  [["cava", "corpinnat"], "default_sparkling"],
  [["penedes"], "medium_white", { red: "medium_red" }],
  [["fino", "manzanilla", "en rama"], "sherry_fino"],
  [["amontillado"], "sherry_amontillado"],
  [["oloroso", "palo cortado"], "sherry_oloroso"],
  [["pedro ximenez", "px", "cream sherry"], "sherry_sweet"],
  [["sherry", "jerez", "xeres", "montilla moriles"], "sherry_fino"],
  // Portugal
  [["vinho verde", "moncao e melgaco", "moncao"], "crisp_white"],
  [["douro"], "syrah", { white: "medium_white" }],
  [["dao", "bairrada"], "medium_red", { white: "medium_white" }],
  [["alentejo", "alentejano"], "grenache", { white: "full_white" }],
  [["colares"], "medium_red"],
  [["tawny"], "port_tawny"],
  [["vintage port", "ruby port", "late bottled vintage", "lbv", "porto", "port wine"], "port_ruby"],
  [["madeira", "sercial", "bual", "boal"], "madeira"],
  // Germany / Austria / Hungary
  [["mosel", "rheingau", "nahe", "pfalz", "rheinhessen", "saar", "ruwer"], "riesling_dry"],
  [["spatlese", "auslese", "beerenauslese", "trockenbeerenauslese", "eiswein", "ice wine", "icewine"], "riesling_sweet"],
  [["wachau", "kamptal", "kremstal", "wagram", "smaragd", "federspiel"], "crisp_white"],
  [["tokaji aszu", "aszu", "tokaji"], "dessert_white", { white: "crisp_white" }],
  // Greece
  [["santorini"], "crisp_white"],
  [["naoussa", "amyndeon"], "nebbiolo"],
  [["nemea"], "merlot"],
  // New world
  [["napa valley", "napa", "oakville", "rutherford", "stags leap", "howell mountain", "paso robles", "coonawarra", "margaret river", "stellenbosch", "maipo"], "cabernet_sauvignon", { white: "chardonnay" }],
  [["sonoma coast", "russian river valley", "russian river", "santa rita hills", "sta rita hills", "anderson valley", "willamette valley", "dundee hills", "eola amity hills", "central otago", "martinborough", "yarra valley", "mornington peninsula", "tasmania", "sta. rita hills"], "pinot_noir", { white: "chardonnay" }],
  [["marlborough"], "sauvignon_blanc", { red: "pinot_noir" }],
  [["barossa", "barossa valley", "mclaren vale", "heathcote"], "syrah", { white: "medium_white" }],
  [["clare valley", "eden valley"], "riesling_dry", { red: "syrah" }],
  [["hunter valley"], "medium_white", { red: "syrah" }],
  [["mendoza", "uco valley", "lujan de cuyo", "cahors"], "malbec", { white: "chardonnay" }],
  [["swartland"], "chenin_blanc", { red: "syrah" }],
  [["lodi", "dry creek valley", "dry creek", "amador county"], "zinfandel"],
  [["alexander valley", "knights valley", "spring mountain", "diamond mountain", "mount veeder", "atlas peak", "red mountain", "walla walla", "columbia valley", "horse heaven hills", "langhorne creek", "colchagua", "cachapoal", "aconcagua"], "cabernet_sauvignon", { white: "chardonnay" }],
  [["carneros", "santa lucia highlands", "santa maria valley", "santa barbara", "chalone", "sonoma mountain", "petaluma gap", "fort ross", "macedon ranges", "geelong", "gippsland", "waipara", "nelson", "hemel en aarde", "walker bay", "elgin"], "pinot_noir", { white: "chardonnay" }],
  [["adelaide hills", "pemberton", "orange nsw", "tumbarumba", "casablanca", "leyda", "san antonio valley", "constantia", "durbanville"], "sauvignon_blanc", { red: "pinot_noir" }],
  [["great southern", "frankland river", "mount barker", "porongurup", "finger lakes"], "riesling_dry", { red: "syrah" }],
  [["bendigo", "grampians", "canberra district", "hilltops", "fleurieu", "gimblett gravels", "hawke s bay", "hawkes bay", "cornas"], "syrah", { white: "chardonnay" }],
  [["rutherglen"], "dessert_white"],
  [["paarl", "franschhoek", "wellington"], "chenin_blanc", { red: "syrah" }],
  [["cafayate", "salta"], "malbec", { white: "aromatic_white" }],
  [["maule", "itata"], "medium_red"],
  [["dogliani", "dolcetto d alba", "dolcetto di dogliani"], "medium_red"],
  [["cru classe", "grand cru classe", "premier grand cru classe", "1er grand cru classe", "2eme cru", "2emes cru", "3eme cru", "3emes cru", "4eme cru", "4emes cru", "5eme cru", "5emes cru", "second cru", "deuxieme cru", "cinquieme cru", "troisieme cru", "quatrieme cru", "premier cru classe"], "cabernet_sauvignon", { white: "sauvignon_blanc" }],
];

/** Explicit style terms (strong evidence). */
export const STYLES: Entry[] = [
  [["nigori", "nigorizake"], "sake_nigori"],
  [["sparkling sake", "awa sake"], "sake_sparkling"],
  [["junmai", "ginjo", "daiginjo", "honjozo", "sake", "nihonshu", "kimoto", "yamahai", "namazake", "shuzo"], "sake"],
  [["umeshu", "plum wine"], "umeshu"],
  [["orange wine", "skin contact", "skin fermented", "amber wine", "ramato", "macerated white"], "orange_wine"],
  [["pet nat", "petillant naturel", "pet nat rose", "col fondo", "ancestral"], "default_sparkling"],
  [["sparkling", "spumante", "espumante", "sekt", "mousseux", "metodo classico", "methode traditionnelle", "traditional method", "brut", "extra brut", "brut nature", "zero dosage", "frizzante"], "default_sparkling"],
  [["noble semillon", "noble riesling", "noble one", "moscato di pantelleria", "passito di pantelleria", "trockenbeerenauslese", "sweet riesling"], "dessert_white"],
  [["late harvest", "noble rot", "botrytis", "vendange tardive", "selection de grains nobles", "dessert wine", "sweet wine", "vin doux naturel", "straw wine", "vin de paille"], "dessert_white"],
  [["rose", "rosado", "rosato", "rosat", "clairet", "blush"], "rose_dry"],
];

/** Colour words in several languages (weakest evidence). */
export const COLOURS: Entry[] = [
  [["red", "rouge", "rosso", "tinto", "tinta", "rot", "rotwein", "vermelho", "rojo", "negre", "red wine", "reds", "vin rouge", "vino rosso", "vinho tinto"], "default_red"],
  [["white", "blanc", "bianco", "blanco", "branco", "weiss", "weisswein", "white wine", "whites", "vin blanc", "vino bianco", "vinho branco", "blanca"], "default_white"],
];

const WHITE_WORDS = new Set(["white", "blanc", "bianco", "blanco", "branco", "weiss", "weisswein", "blanca", "bianca"]);
const RED_WORDS = new Set(["red", "rouge", "rosso", "tinto", "tinta", "rot", "rotwein", "vermelho", "rojo", "negre"]);
const ROSE_WORDS = new Set(["rose", "rosado", "rosato", "rosat"]);
const RED_KEYS = new Set(["light_red", "pinot_noir", "medium_red", "cabernet_sauvignon", "merlot", "syrah", "grenache", "tempranillo", "malbec", "nebbiolo", "sangiovese", "barbera", "zinfandel", "big_tannic_red", "amarone", "default_red"]);

/** Drinks that are not wine: no wine taste profile should be inferred. */
const NOT_WINE = [
  "tequila", "mezcal", "whisky", "whiskey", "bourbon", "scotch", "single malt", "vodka", "gin", "rum", "rhum",
  "cognac", "armagnac", "calvados", "brandy", "grappa", "eau de vie", "pisco", "soju", "shochu", "baijiu",
  "liqueur", "amaro", "aperitivo", "bitters", "beer", "lager", "ale", "pale ale", "ipa", "stout", "pilsner",
  "porter", "cider", "sidra", "kombucha", "cocktail", "mocktail", "soda", "tonic", "juice", "tea", "coffee",
  "espresso", "water", "lemonade",
].map((word) => ` ${word} `);

export function looksLikeNonWine(input: string | null | undefined): boolean {
  const text = normalizeStyleText(input);
  return NOT_WINE.some((needle) => text.includes(needle));
}

export function normalizeStyleText(input: string | null | undefined): string {
  return ` ${(input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

type Match = { start: number; end: number; key: string; tier: number; alt?: Entry[2] };

const TIERS: Array<[Entry[], number]> = [[STYLES, 0], [GRAPES, 1], [APPELLATIONS, 2]];
// Sparkling-only places (Champagne, Cava, Franciacorta...) define the
// style more than any grape listed beside them (Pinot Noir, Xarel-lo), so they rank with style words.
const STYLE_DEFINING_KEYS = new Set(["champagne", "prosecco", "default_sparkling"]);
const COMPILED = TIERS.flatMap(([entries, tier]) => entries.flatMap(([aliases, key, alt]) =>
  aliases.map((alias) => ({ needle: ` ${normalizeStyleText(alias).trim()} `, key, tier: tier === 2 && STYLE_DEFINING_KEYS.has(key) ? 0 : tier, alt }))));
COMPILED.sort((a, b) => b.needle.length - a.needle.length);

function findMatches(text: string): Match[] {
  const taken: Array<[number, number]> = [];
  const matches: Match[] = [];
  for (const { needle, key, tier, alt } of COMPILED) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(needle, from);
      if (index < 0) break;
      const start = index + 1;
      const end = index + needle.length - 1;
      if (!taken.some(([s, e]) => start < e && end > s)) {
        taken.push([start, end]);
        matches.push({ start, end, key, tier, alt });
      }
      from = index + 1;
    }
  }
  return matches;
}

function hasWord(text: string, words: Set<string>): boolean {
  return text.split(" ").some((word) => words.has(word));
}

function applyColour(key: string, alt: Entry[2], text: string): string {
  if (hasWord(text, ROSE_WORDS) && RED_KEYS.has(key)) return "rose_dry";
  if (hasWord(text, WHITE_WORDS) && RED_KEYS.has(key)) return alt?.white ?? "default_white";
  if (hasWord(text, RED_WORDS) && !RED_KEYS.has(key) && alt?.red) return alt.red;
  return key;
}

/**
 * Picks a style key from free text. Returns null when there is no evidence.
 * Within one text: explicit style terms beat grapes, grapes beat appellations,
 * and earlier mentions beat later ones (first-listed grape in a blend).
 */
export function styleKeyFromText(input: string | null | undefined): string | null {
  const text = normalizeStyleText(input);
  if (!text.trim()) return null;
  const matches = findMatches(text);
  // "Sauvignon Blanc" etc. are grapes, so colour words inside them never count.
  const colourText = matches.reduce((t, m) => t.slice(0, m.start) + " ".repeat(m.end - m.start) + t.slice(m.end), text);
  if (matches.length > 0) {
    matches.sort((a, b) => a.tier - b.tier || a.start - b.start);
    const best = matches[0]!;
    return applyColour(best.key, best.alt, colourText);
  }
  return colourKeyFromText(colourText);
}

export function colourKeyFromText(input: string): string | null {
  const text = normalizeStyleText(input);
  if (hasWord(text, ROSE_WORDS)) return "rose_dry";
  for (const [aliases, key] of COLOURS) {
    if (aliases.some((alias) => text.includes(` ${normalizeStyleText(alias).trim()} `))) return key;
  }
  return null;
}
