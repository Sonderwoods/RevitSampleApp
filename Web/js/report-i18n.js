// Report strings (English / Danish) and locale-aware number formatting for the PDF report.
// Every string the report prints comes from here, so a third language is one more object.
// Wording rule: the report is a SCREENING report. Nothing here may say "approved", "compliant", "meets" or
// "godkendt" / "overholder". Numbers are described, not judged against a requirement.

const EN = {
  docTitle: 'Cloudburst screening report',
  docTitleCompare: 'Cloudburst screening report – option comparison',
  screeningShort: 'SCREENING MODEL – results are for design comparison, not for permit or compliance evidence.',
  screeningBoxTitle: 'Screening model – read this first',
  screeningBox: 'This report documents a screening calculation made with Cloudburst. Results are for design comparison, not for permit or compliance evidence. They indicate where water is likely to flow and pond and how a design change alters that, under the stated rain event and simplified assumptions. They are not a hydraulic design, do not replace a sewer model or the municipality\'s own analyses, and do not state that any requirement is met. The method, inputs, assumptions, limitations and validation status are given in this report so that the results can be discussed with the authority.',
  project: 'Project', address: 'Address', matrikel: 'Cadastral no. (matrikel)', client: 'Client', author: 'Prepared by', company: 'Company',
  date: 'Date', revision: 'Revision', notes: 'Notes', page: 'Page', of: 'of', generated: 'Generated', notGiven: '–',
  toc: 'Contents',
  // sections
  secSummary: 'Summary', secSite: 'Site and terrain', secRain: 'Rain event and drainage assumptions', secSurfaces: 'Surfaces and materials',
  secMaps: 'Result maps', secBalance: 'Water balance', secRetention: 'Retention (indicative)', secMethod: 'Method, assumptions and limitations',
  secValidation: 'Validation status', secAppendix: 'Appendix – parameters', secCompareSummary: 'Comparison summary', secKeyFigures: 'Key figures',
  secNeighbours: 'Water leaving the site (towards neighbours / downstream)', secDiff: 'Difference map', secInputsCompare: 'Inputs per option',
  secSideBySide: 'Maximum water depth, side by side', secSurfacesCompare: 'Surfaces per option', secBluespots: 'Largest bluespots',
  // key figure labels
  kfRain: 'Rain on site', kfDesignDepth: 'Design rain depth', kfPonded: 'Water ponding on site', kfLeaves: 'Water leaving the site boundary',
  kfFlooded: 'Wet area (depth 1 cm or more)', kfFloodedDyn: 'Wet area (max depth 3 cm or more)', kfOver: 'Area with depth over {cm} cm', kfMaxDepth: 'Maximum depth',
  kfBluespots: 'Bluespots (depressions holding water)', kfSpilling: 'of which spilling over', kfLosses: 'Sewer, infiltration and initial losses',
  kfEffective: 'Effective runoff after losses', kfStorage: 'Required storage (indicative)', kfReducedArea: 'Reduced area (sum of C·A)', kfRationalPeak: 'Peak runoff, rational method',
  kfMaxVel: 'Maximum velocity', kfHazardHigh: 'Area with hazard "danger for some" or higher', kfHv: 'Area where depth × velocity exceeds 0.5 m²/s',
  kfMassError: 'Mass balance error', kfInitialLoss: 'Initial loss (interception, depressions)', kfInfiltrated: 'Infiltrated', kfSewer: 'To sewer',
  kfStoredEnd: 'On site at end of simulation', kfMeanC: 'Mean runoff coefficient C', kfAllowedOut: 'Allowed discharge', kfCritDur: 'Critical rain duration',
  designChanges: 'Surface changes made in the app (step 3)', designAsDrawn: 'none – surfaces as drawn', groundTo: 'everything else',
  kfTotalArea: 'Site area (model domain)', kfAllowedOutSite: 'Allowed outflow from the site', jbTable: 'from JB soil table ({c})', jbCompacted: 'compacted', jbLoose: 'loose', tagInstant: 'INSTANT', tagDynamic: 'DYNAMIC',
  // table headers
  thQuantity: 'Quantity', thValue: 'Value', thUnit: 'Unit', thChange: 'Change {x}–{a}', thChangePct: 'Change %', thOption: 'Option',
  thMaterial: 'Surface / material', thArea: 'Area', thShare: 'Share', thCNormal: 'C normal', thCCb: 'C cloudburst sand / clay', thManning: 'Manning n',
  thInfil: 'Infiltration sand / clay (mm/h)', thIa: 'Initial loss (mm)', thSubbase: 'Sub-base storage (mm)', subbaseCell: '{mm} *', thVolume: 'Volume', thDepth: 'Max depth', thSpills: 'Spills', thSpillRain: 'Spills at rain',
  thField: 'Input', thTest: 'Test', thStatus: 'Status', thParam: 'Parameter', thNo: 'No.', thComponent: 'Component', thShareOfRain: 'Share of rain',
  yes: 'yes', no: 'no', fillPct: '{p} % full',
  // site
  siteName: 'Site', siteKind: 'Site type', kindSynthetic: 'Synthetic sample site (built into the engine)', kindReal: 'Real site (terrain from DHM)', kindCustom: 'Uploaded or fetched terrain',
  terrainSource: 'Terrain source', terrainDate: 'Terrain date / retrieval', terrainDateUnknown: 'Not given – state the terrain release or survey date (e.g. DHM/Terræn 2023) in the report dialog.',
  nativeRes: 'Native resolution of the terrain data', nativeResUnknown: 'unknown (not in the file)', suitability: 'Fitness for site-scale screening', aggMethod: 'Terrain aggregation to the grid',
  aggMethods: { mean: 'mean of the terrain samples in each cell', min: 'lowest sample in each cell', max: 'highest sample in each cell', nearest: 'nearest sample, no averaging', reproject: 'reprojected (bilinear interpolation)' },
  vertDatum: 'Vertical datum', uploadedFile: 'Uploaded file: {f}', uploadedFileNoName: 'Uploaded terrain file', osmContext: 'Buildings and surfaces', osmVal: 'from OpenStreetMap – buildings: {b}, surface areas: {s}, bridge cut-outs: {c}', osmNone: 'none – terrain only; every surface is the ground material set in the app',
  terrainWarnings: 'Terrain processing messages', crsNone: 'none in the file – coordinates used as local metres',
  suitLabels: { good: 'Good for site screening', fair: 'Usable with care', poor: 'Overview only', unsuitable: 'NOT suitable for site screening' },
  suitMsgs: { good: 'Native {res} m: kerbs, gutters and courtyards can be resolved.', fair: 'Native {res} m: streets and blocks are resolved, kerbs and gutters are not.', fairUnknown: 'Resolution unknown: check that the file is a bare-earth terrain model (DTM) of 2 m or finer.', poor: 'Native {res} m: only the broad catchment shape is right; flow paths along streets and bluespots in courtyards are not reliable.', unsuitable: 'Native {res} m: not adequate for site-scale cloudburst screening. Use it only for a regional overview; a terrain of 1 m or finer (LiDAR DTM) is needed for the site.' },
  suitDsm: 'It is a surface model (buildings and trees partly included), so flow paths are distorted.',
  coarseTitle: 'Warning: terrain NOT suitable for site screening', coarsePoorTitle: 'Warning: coarse terrain – overview only',
  coarseBody: 'The terrain of {opt} comes from {src} with a native resolution of {res} m. {msg} Depths, areas and volumes in this report are therefore not reliable at site scale and must not be used to discuss the site with an authority.',
  coarsePoorBody: 'The terrain of {opt} comes from {src} with a native resolution of {res} m. {msg} Treat the depths, areas and volumes in this report as indicative of the broad catchment only.',
  attribution: 'Attribution', crs: 'Coordinate system', crsLocal: 'Local metres (synthetic site)', extent: 'Model extent', origin: 'Grid origin (south-west corner)',
  cellSize: 'Grid cell size', cells: 'Grid cells', gridWarnings: 'Grid builder messages', synthTerrain: 'Synthetic terrain, buildings and surfaces defined in the Cloudburst sample library (no survey data).',
  dhmAttribution: 'Contains data from Klimadatastyrelsen (Danish Agency for Climate Data): Danmarks Højdemodel, DHM/Terræn.',
  // rain
  rainEvent: 'Rain event', returnPeriod: 'Return period', years: '{n} years', rpNone: 'not a return-period event', rainDepth: 'Rain depth before climate factor',
  climateFactor: 'Climate factor', designDepth: 'Design rain depth', duration: 'Duration', peakIntensity: 'Peak 1-minute intensity (with climate factor)', rainShape: 'Shape',
  rainCustom: 'Rain depth set by the user ({d} mm instead of the preset\'s {p} mm).', sewer: 'Sewer assumption', moisture: 'Antecedent soil moisture', soil: 'Soil class',
  soilDefault: 'JB-6 fine sandy clay (engine default; not set per area in the web app)', hyetoCaption: 'Rain intensity over time (design event incl. climate factor), mm/h',
  rainSource: 'Rain source', rainSourceText: 'Indicative Danish IDF curve calibrated to 4-hour depths for Odense (Spildevandskomiteen Skrift 30). CDS events: 1-minute alternating blocks with the peak at the centre, scaled to the rain depth; the climate factor multiplies every block. Regenerate with the Skrift 32 tool for the site before using numbers in a project.',
  sewerNone: 'No sewer', sewerCombined: 'Combined sewer, 34 mm initial loss on sealed surfaces', sewerSeparate: 'Separate sewer, 29 mm initial loss on sealed surfaces',
  moistDry: 'Dry', moistMoist: 'Moist (default)', moistWet: 'Wet',
  model: 'Model', modelInstant: 'Instant bluespot model (M1: fill–spill–merge, depth when depressions are full)', modelDynamic: 'Dynamic 2D model (M2: local-inertial shallow water over time)',
  dynCell: 'Dynamic model cell size', dynSim: 'Simulated time',
  // surfaces
  surfacesNote: 'Areas are counted from the model grid (cells × cell area). Parameters are the defaults of the Cloudburst material palette as used by the engine. For their sources and the infiltration model see docs/physics-permeability.md.',
  subbaseNote: '* Sub-base: water that soaks in through the surface fills a sub-base that drains to the subsoil at the soil\'s rate (JB fc of the soil class), not at the surface rate. Once it is full the surface takes no more water than the subsoil drains (dynamic model).',
  jbNote: 'Materials marked "from JB soil table" take their infiltration rates from the soil class (JB-6 unless set) in the dynamic model; the palette\'s sand/clay rates are not used for them.',
  buildings: 'Buildings (roofs, treated as obstacles; roof water per drainage assumption)',
  // maps
  mapDepthInstant: 'Water depth when bluespots are full (instant model)', mapDepthDyn: 'Maximum water depth over the event (dynamic model)', mapHazard: 'Flood hazard h·(v+0.5) (dynamic model)',
  mapVelocity: 'Maximum velocity (dynamic model)', mapMaterials: 'Surface materials', mapDiff: 'Change in maximum water depth, {b} minus {a}',
  legendLabels: {}, // English legends use the app's own ramp labels (js/colors.js)
  legendDepth: 'Water depth (cm)', legendHazard: 'Hazard (m²/s)', legendVelocity: 'Velocity (m/s)', legendDiff: 'Depth change {b} – {a} (cm)',
  hiddenBelow: 'Depths below {cm} cm not shown.', flowPathNote: 'Blue lines: main flow paths, width increases with upstream volume. Numbered dots: largest bluespots (see table).',
  diffBetter: 'GREEN = less water in {b} than in {a}', diffWorse: 'RED = more water in {b} than in {a}', diffNote: 'Changes smaller than 1 cm are not shown. Red inside a planned retention or LAR area can be intended (water stored where it was designed to be); red elsewhere, especially near the site boundary, deserves attention.',
  scale: 'Scale', north: 'N', mapCaption: 'Caption',
  // balance
  balanceInstantNote: 'Instant model: the rain on the site minus losses (sewer initial loss, infiltration and initial loss, lumped) is routed over the terrain; water fills depressions (bluespots) and the rest leaves the model boundary, which is treated as open on all sides.',
  balanceDynNote: 'Dynamic model: the engine tracks every volume each time step. The mass balance error is (rain − all sinks − water on site) / rain; the target in the PRD is below 0.1 %.',
  kfSubbaseStill: 'of which still in sub-bases at the end', kfSubbaseDrained: 'of which drained from sub-bases to the subsoil', kfSubbaseCap: 'Sub-base capacity (all sub-base cells)', kfSubbaseFull: 'Sub-base cells that ran full', subbaseFullVal: '{n} of {m}',
  balanceSubbaseNote: 'Infiltrated water includes the water that entered a sub-base (permeable paving, porous asphalt, rain garden). A sub-base that ran full accepted no more than the subsoil drains for the rest of the event.',
  noDynamic: 'No dynamic simulation was run for this result, so velocity, hazard, infiltration over time and the mass balance are not available. Run the dynamic simulation before exporting to include them.',
  // retention
  retentionNote: 'Box-rain method: required storage = max over durations d of (i(d,T) · climate factor · reduced area − allowed discharge) · d, times a safety factor. Reduced area uses the administrative (normal) runoff coefficients. Indicative only: the municipality\'s own method, rain series and discharge limit apply.',
  retInputDischarge: 'Allowed discharge', retInputT: 'Return period for retention', retInputCf: 'Climate factor used', retInputSf: 'Safety factor',
  retNotAvailable: 'Retention was not calculated for this option.',
  // comparison
  baseline: 'Baseline', optionLetter: 'Option {l}', basisInstant: 'Compared on the instant model (bluespots full).', basisDynamic: 'Compared on the dynamic model (maximum depth over the event).',
  sameInputs: 'Both options were run with the same rain event, drainage and soil assumptions and grid cell size, so the differences below come from the design (terrain, surfaces, buildings).',
  inputsDiffer: 'Caution: the options were NOT run with identical inputs ({list}). Differences in the results reflect these input changes as well as the design.',
  sideBySideNote: 'Same colour scale and extent for all options.',
  diffStatsWetter: 'Area that is wetter in {b} (1 cm or more)', diffStatsDrier: 'Area that is drier in {b} (1 cm or more)', diffStatsMaxUp: 'Largest local increase', diffStatsMaxDown: 'Largest local decrease',
  diffStatsEdgeWetter: 'Wetter area within {m} m of the site boundary', diffStatsEdgeDrier: 'Drier area within {m} m of the site boundary',
  neighboursIntro: 'Authorities typically ask whether a design worsens conditions for neighbours or downstream. The screening gives the total volume that leaves the model boundary and how the depth changes near the boundary. It does not split the outflow by neighbour or give a discharge hydrograph.',
  // summary sentences (neutral, generated from numbers)
  sumEvent: 'Both options are evaluated for {event}: {depth} mm × climate factor {cf} = {design} mm of rain on {area}.',
  sumPonded: 'Water ponding on the site is {va} m³ in {a} and {vb} m³ in {b}: {dir}.',
  sumOver10: 'The area with water deeper than 10 cm is {va} m² in {a} and {vb} m² in {b}: {dir}.',
  sumMax: 'The maximum depth is {va} cm in {a} and {vb} cm in {b}.',
  sumLeaves: 'Water leaving the site boundary is {va} m³ in {a} and {vb} m³ in {b}: {dir}.',
  sumLeavesUp: 'In this screening {b} sends more water across the site boundary than {a}. This should be discussed with the authority, together with where the water goes.',
  sumLeavesDown: 'In this screening {b} sends less water across the site boundary than {a}.',
  sumLeavesSame: 'In this screening the water leaving the site is essentially unchanged.',
  sumEdge: 'Within {m} m of the site boundary, {wet} m² is wetter and {dry} m² is drier in {b} (1 cm or more).',
  sumStorage: 'Indicative required storage is {va} m³ for {a} and {vb} m³ for {b}.',
  sumCaveat: 'These statements describe screening results only. They do not show that any requirement is met.',
  dirDown: 'a decrease of {d} ({p} %)', dirUp: 'an increase of {d} ({p} %)', dirSame: 'essentially unchanged', dirNew: 'an increase of {d} (from zero)',
  // single summary
  sumSingle1: 'For {event} ({design} mm of rain incl. climate factor {cf}) the screening gives {ponded} m³ of water ponding on the site and {leaves} m³ leaving the site boundary, out of {rain} m³ of rain.',
  sumSingle2: 'Water deeper than 10 cm covers {a10} m²; the maximum depth is {max} cm.',
  sumSingle3: 'The dynamic run gives a maximum velocity of {v} m/s and {hz} m² with hazard "danger for some" or higher (mass balance error {err} %).',
  sumSingle4: 'Indicative required storage for a discharge limit of {q} l/s/ha (T = {t} years) is {s} m³.',
  // method
  methodIntro: 'Cloudburst is a screening tool. The same Rust engine runs in the web app and in the Revit and Rhino plug-ins. The full model description, parameter tables and their sources are in docs/physics-permeability.md and docs/PRD.md in the Cloudburst repository.',
  methodM1: 'Instant model (M1): effective rain per cell = min(C·P, P − Ia) minus the sewer loss, where P is the design rain depth, C the cloudburst runoff coefficient of the material (blended for the soil) and Ia its initial loss; priority-flood depression detection and fill–spill–merge; multiple-flow-direction flow paths. Gives depths when depressions are full; no timing, velocity or hazard.',
  methodM2: 'Dynamic model (M2): local-inertial 2D shallow-water equations (Bates et al. 2010, de Almeida et al. 2012) with rain on the grid, an initial-loss bucket, modified Horton infiltration driven by cumulative infiltration, sub-base reservoirs under permeable paving, porous asphalt and rain gardens that drain to the subsoil at the soil\'s rate, and a uniform sewer loss, with a full mass balance.',
  methodRet: 'Retention (OUT-8): reduced area Σ C·A with administrative coefficients and the box-rain method with an indicative IDF curve.',
  assumptionsTitle: 'Key assumptions',
  assumptions: [
    'Buildings are solid blocks at least 5 m high; roof water goes to the sewer unless stated otherwise.',
    'The sewer is represented as a uniform initial loss on sealed surfaces (34 mm combined, 29 mm separate), not as a pipe network. Local weak points in the sewer are not visible.',
    'Model boundaries are open: water reaching the edge leaves the model. Upstream water entering the site from outside the model extent is not included.',
    'Soil is one class for the whole site (JB-6 unless set); infiltration on compacted urban soil is uncertain by a factor of 3–8.',
    'Rain falls uniformly over the site. Rain depths come from an indicative IDF curve, not from the current Spildevandskomiteen tool.',
    'Terrain is resampled to the grid cell size; kerbs, culverts, underpasses and bridge decks not represented in the grid change the flow paths.',
  ],
  limitationsTitle: 'Limitations',
  limitations: [
    'Results are screening results for design comparison, not for permit or compliance evidence.',
    'No coupling to a sewer network model (planned M3); sewer surcharge is not modelled.',
    'No ensemble or uncertainty ranges yet (SIM-7); single deterministic runs.',
    'Outflow across the boundary is a site total; it is not split by neighbour and no discharge hydrograph is produced.',
    'Façade flags, probes and GeoTIFF export (OUT-5, OUT-6, OUT-10) are not part of this report.',
    'Not calibrated against a reference model (MIKE, SCALGO Live) for this site.',
    'No recovery of infiltration capacity between showers: soils and sub-bases only fill during the event. Adequate for one design storm of a few hours, not for a series of storms.',
    'High groundwater is not represented. The engine can cap infiltration per cell, but that needs groundwater data the tool does not have; no cap is applied by default.',
    'The instant model (runoff coefficients) and the dynamic model (Horton infiltration from the JB soil table) can disagree markedly on soil surfaces such as lawns; on sealed surfaces they agree closely. Use the dynamic model for figures that depend on infiltration.',
    'Design-storm peak: the CDS rain uses 1-minute blocks (T = 100: about 457 mm/h with climate factor 1.4). On sample sites a 5- or 10-minute peak changed infiltration and the water leaving the site by under 1 % but the area deeper than 10 cm by up to 9 %; peak-related results are the most sensitive to this choice.',
  ],
  validationIntro: 'Automated tests in the engine (status as stated in the repository README for this engine version). A site-specific validation has not been made.',
  validation: [
    ['Lake at rest', 'Passes: velocities below 1e-4 m/s'],
    ['Tilted plane vs kinematic wave', 'Within 15 % (PRD target is 5 % on outflow)'],
    ['Rain-on-grid mass balance', 'Passes: error about 1e-6 (target 0.1 %)'],
    ['Floodplain depression filling (EA Test 2 style)', 'Passes: volume conserved, flat levels'],
    ['M1 fill–spill conservation and cascades', 'Passes'],
    ['Retention vs hand calculation', 'Passes'],
    ['EA Test 8A, comparison with SCALGO Live', 'Not done: needs reference data / test site'],
  ],
  // appendix
  appEngine: 'Engine version', appTool: 'Tool', appSchema: 'Report data schema', appBasis: 'Result basis', appCreated: 'Option saved', appGridDims: 'Grid (columns × rows)',
  appCaption: 'Map caption (OUT-9)', appParamsNote: 'All values are those held by the app when the report was generated. The report data (JSON) can be exported from the same dialog for archiving.',
  units: { m3: 'm³', m2: 'm²', cm: 'cm', mm: 'mm', ls: 'l/s', lsha: 'l/s/ha', ms: 'm/s', pct: '%', min: 'min', m: 'm', h: 'h', ha: 'ha' },
  presetNames: { t10: 'T = 10 years', t100: 'T = 100 years (cloudburst)', test2011: '2011 test (Copenhagen 2 July 2011)', box83: 'Box rain 83 mm / 4 h' },
  shapeCds: 'Chicago design storm (CDS, alternating block)', shapeBox: 'Box rain (constant intensity)',
  // dialog
  dlgTitle: 'Export report (PDF)', dlgType: 'Report type', dlgSingle: 'Single result', dlgCompare: 'Compare options', dlgSource: 'Result',
  dlgCurrent: 'Current result', dlgOptions: 'Options to compare (first ticked = baseline A)', dlgNoOptions: 'Save at least two options first: step 5 “Compare designs” → “Save as option A”, change a surface or the rain, then “Save as option B”. A before/after sample can also use “Compare with …”.',
  dlgSaveCurrent: 'Save current result as option', dlgTerrainDatePh: 'e.g. DHM/Terræn 2023, or survey date', dlgLanguage: 'Language', dlgDownload: 'Download PDF', dlgJson: 'Report data (JSON)', dlgCancel: 'Cancel',
  dlgWorking: 'Building report…', dlgDone: 'Report saved.', dlgProject: 'Project details (printed on every page)', dlgNotesPh: 'Free text, e.g. what was changed between the options, open questions for the authority.',
  dlgDisclaimer: 'The report is a transparent screening report. It always carries the statement “results are for design comparison, not for permit or compliance evidence”.',
};

const DA = {
  docTitle: 'Skybrudsscreening – rapport',
  docTitleCompare: 'Skybrudsscreening – sammenligning af forslag',
  screeningShort: 'SCREENINGSMODEL – resultaterne er til sammenligning af forslag, ikke dokumentation til myndighedsgodkendelse eller overholdelse af krav.',
  screeningBoxTitle: 'Screeningsmodel – læs dette først',
  screeningBox: 'Rapporten dokumenterer en screeningsberegning udført med Cloudburst. Resultaterne er til sammenligning af forslag og er ikke dokumentation til myndighedsgodkendelse eller for, at krav er overholdt. De viser, hvor vandet sandsynligvis løber og samler sig, og hvordan en ændring af projektet påvirker det, for den angivne regnhændelse og under forenklede antagelser. De er ikke en hydraulisk dimensionering, erstatter ikke en afløbsmodel eller kommunens egne analyser og siger ikke, at et krav er opfyldt. Metode, input, antagelser, begrænsninger og valideringsstatus er beskrevet i rapporten, så resultaterne kan danne grundlag for en dialog med myndigheden.',
  project: 'Projekt', address: 'Adresse', matrikel: 'Matrikelnr.', client: 'Bygherre', author: 'Udarbejdet af', company: 'Firma',
  date: 'Dato', revision: 'Revision', notes: 'Bemærkninger', page: 'Side', of: 'af', generated: 'Genereret', notGiven: '–',
  toc: 'Indhold',
  secSummary: 'Resumé', secSite: 'Grund og terræn', secRain: 'Regnhændelse og afløbsforudsætninger', secSurfaces: 'Overflader og materialer',
  secMaps: 'Resultatkort', secBalance: 'Vandbalance', secRetention: 'Forsinkelse (vejledende)', secMethod: 'Metode, antagelser og begrænsninger',
  secValidation: 'Valideringsstatus', secAppendix: 'Bilag – parametre', secCompareSummary: 'Resumé af sammenligningen', secKeyFigures: 'Nøgletal',
  secNeighbours: 'Vand der forlader grunden (mod naboer / nedstrøms)', secDiff: 'Differenskort', secInputsCompare: 'Input pr. forslag',
  secSideBySide: 'Maksimal vanddybde side om side', secSurfacesCompare: 'Overflader pr. forslag', secBluespots: 'Største bluespots',
  kfRain: 'Regn på grunden', kfDesignDepth: 'Dimensionerende regndybde', kfPonded: 'Vand der samler sig på grunden', kfLeaves: 'Vand der forlader grundens afgrænsning',
  kfFlooded: 'Vådt areal (dybde 1 cm eller mere)', kfFloodedDyn: 'Vådt areal (maks. dybde 3 cm eller mere)', kfOver: 'Areal med dybde over {cm} cm', kfMaxDepth: 'Største vanddybde',
  kfBluespots: 'Bluespots (lavninger der holder vand)', kfSpilling: 'heraf med overløb', kfLosses: 'Kloak, nedsivning og initialtab',
  kfEffective: 'Effektiv afstrømning efter tab', kfStorage: 'Nødvendigt forsinkelsesvolumen (vejledende)', kfReducedArea: 'Reduceret areal (sum af C·A)', kfRationalPeak: 'Maks. afstrømning, rationel metode',
  kfMaxVel: 'Største hastighed', kfHazardHigh: 'Areal med fare "farligt for nogle" eller højere', kfHv: 'Areal hvor dybde × hastighed overstiger 0,5 m²/s',
  kfMassError: 'Fejl i massebalance', kfInitialLoss: 'Initialtab (interception, lavninger)', kfInfiltrated: 'Nedsivet', kfSewer: 'Til kloak',
  kfStoredEnd: 'På grunden ved simuleringens slutning', kfMeanC: 'Gennemsnitlig afløbskoefficient C', kfAllowedOut: 'Tilladt afledning', kfCritDur: 'Kritisk regnvarighed',
  designChanges: 'Overfladeændringer foretaget i appen (trin 3)', designAsDrawn: 'ingen – overflader som tegnet', groundTo: 'alt andet',
  kfTotalArea: 'Grundens areal (modelområde)', kfAllowedOutSite: 'Tilladt afledning fra grunden', jbTable: 'fra JB-jordtabellen ({c})', jbCompacted: 'komprimeret', jbLoose: 'løs', tagInstant: 'ØJEBLIK', tagDynamic: 'DYNAMISK',
  thQuantity: 'Størrelse', thValue: 'Værdi', thUnit: 'Enhed', thChange: 'Ændring {x}–{a}', thChangePct: 'Ændring %', thOption: 'Forslag',
  thMaterial: 'Overflade / materiale', thArea: 'Areal', thShare: 'Andel', thCNormal: 'C normal', thCCb: 'C skybrud sand / ler', thManning: 'Manning n',
  thInfil: 'Nedsivning sand / ler (mm/t)', thIa: 'Initialtab (mm)', thSubbase: 'Magasin i bærelag (mm)', subbaseCell: '{mm} *', thVolume: 'Volumen', thDepth: 'Maks. dybde', thSpills: 'Overløb', thSpillRain: 'Overløb ved regn',
  thField: 'Input', thTest: 'Test', thStatus: 'Status', thParam: 'Parameter', thNo: 'Nr.', thComponent: 'Komponent', thShareOfRain: 'Andel af regn',
  yes: 'ja', no: 'nej', fillPct: '{p} % fyldt',
  siteName: 'Grund', siteKind: 'Type', kindSynthetic: 'Syntetisk eksempelgrund (indbygget i motoren)', kindReal: 'Virkelig grund (terræn fra DHM)', kindCustom: 'Uploadet eller hentet terræn',
  terrainSource: 'Terrænkilde', terrainDate: 'Terrænets dato / hentet', terrainDateUnknown: 'Ikke angivet – angiv terrænets version eller opmålingsdato (fx DHM/Terræn 2023) i rapportdialogen.',
  nativeRes: 'Terrændataenes oprindelige opløsning', nativeResUnknown: 'ukendt (ikke i filen)', suitability: 'Egnethed til screening på grundniveau', aggMethod: 'Terrænets sammenlægning til gridet',
  aggMethods: { mean: 'middelværdi af terrænpunkterne i hver celle', min: 'laveste punkt i hver celle', max: 'højeste punkt i hver celle', nearest: 'nærmeste punkt, ingen middelværdi', reproject: 'omprojiceret (bilineær interpolation)' },
  vertDatum: 'Højdesystem', uploadedFile: 'Uploadet fil: {f}', uploadedFileNoName: 'Uploadet terrænfil', osmContext: 'Bygninger og overflader', osmVal: 'fra OpenStreetMap – bygninger: {b}, overfladearealer: {s}, udskæringer for broer: {c}', osmNone: 'ingen – kun terræn; alle overflader har det jordmateriale, der er valgt i appen',
  terrainWarnings: 'Meddelelser fra terrænbehandlingen', crsNone: 'intet i filen – koordinater brugt som lokale meter',
  suitLabels: { good: 'God til screening på grundniveau', fair: 'Brugbar med forsigtighed', poor: 'Kun til overblik', unsuitable: 'IKKE egnet til screening på grundniveau' },
  suitMsgs: { good: 'Oprindelig opløsning {res} m: kantsten, render og gårde kan opløses.', fair: 'Oprindelig opløsning {res} m: gader og karréer opløses, kantsten og render gør ikke.', fairUnknown: 'Ukendt opløsning: kontrollér at filen er en terrænmodel (DTM) på 2 m eller finere.', poor: 'Oprindelig opløsning {res} m: kun oplandets overordnede form er rigtig; strømningsveje langs gader og bluespots i gårde er ikke pålidelige.', unsuitable: 'Oprindelig opløsning {res} m: ikke tilstrækkelig til skybrudsscreening på grundniveau. Brug den kun til et regionalt overblik; grunden kræver et terræn på 1 m eller finere (LiDAR-DTM).' },
  suitDsm: 'Det er en overflademodel (bygninger og træer delvis med), så strømningsvejene er forvrængede.',
  coarseTitle: 'Advarsel: terrænet er IKKE egnet til screening på grundniveau', coarsePoorTitle: 'Advarsel: groft terræn – kun til overblik',
  coarseBody: 'Terrænet for {opt} kommer fra {src} med en oprindelig opløsning på {res} m. {msg} Dybder, arealer og volumener i rapporten er derfor ikke pålidelige på grundniveau og må ikke bruges til at drøfte grunden med en myndighed.',
  coarsePoorBody: 'Terrænet for {opt} kommer fra {src} med en oprindelig opløsning på {res} m. {msg} Dybder, arealer og volumener i rapporten skal kun læses som vejledende for oplandet som helhed.',
  attribution: 'Kildeangivelse', crs: 'Koordinatsystem', crsLocal: 'Lokale meter (syntetisk grund)', extent: 'Modelområde', origin: 'Gridets nulpunkt (sydvestligt hjørne)',
  cellSize: 'Cellestørrelse', cells: 'Antal celler', gridWarnings: 'Meddelelser fra gridopbygning', synthTerrain: 'Syntetisk terræn, bygninger og overflader fra Cloudbursts eksempelbibliotek (ikke opmålte data).',
  dhmAttribution: 'Indeholder data fra Klimadatastyrelsen: Danmarks Højdemodel, DHM/Terræn.',
  rainEvent: 'Regnhændelse', returnPeriod: 'Gentagelsesperiode', years: '{n} år', rpNone: 'ikke en hændelse med gentagelsesperiode', rainDepth: 'Regndybde før klimafaktor',
  climateFactor: 'Klimafaktor', designDepth: 'Dimensionerende regndybde', duration: 'Varighed', peakIntensity: 'Maks. 1-minuts intensitet (inkl. klimafaktor)', rainShape: 'Form',
  rainCustom: 'Regndybden er sat af brugeren ({d} mm i stedet for {p} mm).', sewer: 'Kloakforudsætning', moisture: 'Jordfugtighed før regn', soil: 'Jordtype',
  soilDefault: 'JB-6 finsandet lerjord (motorens standard; kan ikke sættes pr. område i webappen)', hyetoCaption: 'Regnintensitet over tid (dimensionerende hændelse inkl. klimafaktor), mm/t',
  rainSource: 'Regnkilde', rainSourceText: 'Vejledende dansk IDF-kurve kalibreret til 4-timers regndybder for Odense (Spildevandskomiteens Skrift 30). CDS-regn: alternerende blokke på 1 minut med toppen i midten, skaleret til regndybden; klimafaktoren ganges på hver blok. Beregn med Skrift 32-værktøjet for stedet, før tallene bruges i et projekt.',
  sewerNone: 'Ingen kloak', sewerCombined: 'Fællessystem, 34 mm initialtab på befæstede flader', sewerSeparate: 'Separatsystem, 29 mm initialtab på befæstede flader',
  moistDry: 'Tør', moistMoist: 'Fugtig (standard)', moistWet: 'Våd',
  model: 'Model', modelInstant: 'Øjebliksmodel for bluespots (M1: fill–spill–merge, dybder når lavningerne er fyldt)', modelDynamic: 'Dynamisk 2D-model (M2: lokal-inertiel lavvandsmodel over tid)',
  dynCell: 'Cellestørrelse i dynamisk model', dynSim: 'Simuleret tid',
  surfacesNote: 'Arealer er optalt i modellens grid (celler × celleareal). Parametrene er standardværdierne i Cloudbursts materialepalet, som motoren bruger. Kilder og nedsivningsmodel: se docs/physics-permeability.md.',
  subbaseNote: '* Bærelag: vand der siver ned gennem belægningen fylder et bærelag, som dræner til underjorden med jordens hastighed (JB-jordtypens fc), ikke med belægningens. Når det er fyldt, tager belægningen ikke mere vand, end underjorden dræner (dynamisk model).',
  jbNote: 'Materialer markeret "fra JB-jordtabellen" får deres nedsivningshastighed fra jordtypen (JB-6 hvis ikke andet er sat) i den dynamiske model; palettens sand/ler-værdier bruges ikke for dem.',
  buildings: 'Bygninger (tage, behandlet som forhindringer; tagvand efter afløbsforudsætningen)',
  mapDepthInstant: 'Vanddybde når bluespots er fyldt (øjebliksmodel)', mapDepthDyn: 'Maksimal vanddybde under hændelsen (dynamisk model)', mapHazard: 'Faregrad h·(v+0,5) (dynamisk model)',
  mapVelocity: 'Maksimal hastighed (dynamisk model)', mapMaterials: 'Overflader og materialer', mapDiff: 'Ændring i maksimal vanddybde, {b} minus {a}',
  legendLabels: { diff: ['Tørrere med > 20', 'Tørrere med 10–20', 'Tørrere med 1–10', 'Vådere med 1–10', 'Vådere med 10–20', 'Vådere med > 20'], hazard: ['Lav  (< 0,5)', 'Forsigtighed  (0,5–0,75)', 'Farligt for nogle  (0,75–1,25)', 'Farligt for de fleste  (1,25–2)', 'Farligt for alle  (> 2)'], velocity: ['0,05–0,25', '0,25–0,5', '0,5–1', '1–2', '> 2'] },
  legendDepth: 'Vanddybde (cm)', legendHazard: 'Faregrad (m²/s)', legendVelocity: 'Hastighed (m/s)', legendDiff: 'Dybdeændring {b} – {a} (cm)',
  hiddenBelow: 'Dybder under {cm} cm er ikke vist.', flowPathNote: 'Blå linjer: vigtigste strømningsveje, bredden vokser med opstrøms volumen. Nummererede punkter: største bluespots (se tabel).',
  diffBetter: 'GRØN = mindre vand i {b} end i {a}', diffWorse: 'RØD = mere vand i {b} end i {a}', diffNote: 'Ændringer under 1 cm er ikke vist. Rødt i et planlagt forsinkelses- eller LAR-areal kan være tilsigtet (vandet står hvor det er planlagt); rødt andre steder, især nær grundens afgrænsning, bør undersøges.',
  scale: 'Målestok', north: 'N', mapCaption: 'Billedtekst',
  balanceInstantNote: 'Øjebliksmodel: regnen på grunden minus tab (kloak-initialtab, nedsivning og initialtab samlet) føres over terrænet; vandet fylder lavninger (bluespots), og resten forlader modellens rand, der regnes åben på alle sider.',
  balanceDynNote: 'Dynamisk model: motoren fører regnskab med alle volumener i hvert tidsskridt. Massebalancefejlen er (regn − alle tab − vand på grunden) / regn; målet i PRD er under 0,1 %.',
  kfSubbaseStill: 'heraf stadig i bærelag ved slutningen', kfSubbaseDrained: 'heraf drænet fra bærelag til underjorden', kfSubbaseCap: 'Bærelagenes magasin (alle bærelagsceller)', kfSubbaseFull: 'Bærelagsceller der blev fyldt', subbaseFullVal: '{n} af {m}',
  balanceSubbaseNote: 'Nedsivet vand omfatter det vand, der er løbet ned i et bærelag (permeabel belægning, drænasfalt, regnbed). Et bærelag der blev fyldt, tog resten af hændelsen ikke mere vand, end underjorden drænede.',
  noDynamic: 'Der er ikke kørt en dynamisk simulering for dette resultat, så hastighed, faregrad, nedsivning over tid og massebalance er ikke med. Kør den dynamiske simulering før eksport for at få dem med.',
  retentionNote: 'Kasseregnsmetoden: nødvendigt volumen = maks. over varigheder d af (i(d,T) · klimafaktor · reduceret areal − tilladt afledning) · d, gange en sikkerhedsfaktor. Reduceret areal bruger de administrative (normale) afløbskoefficienter. Kun vejledende: kommunens egen metode, regnserie og afledningskrav gælder.',
  retInputDischarge: 'Tilladt afledning', retInputT: 'Gentagelsesperiode for forsinkelse', retInputCf: 'Anvendt klimafaktor', retInputSf: 'Sikkerhedsfaktor',
  retNotAvailable: 'Forsinkelse er ikke beregnet for dette forslag.',
  baseline: 'Basis', optionLetter: 'Forslag {l}', basisInstant: 'Sammenlignet med øjebliksmodellen (bluespots fyldt).', basisDynamic: 'Sammenlignet med den dynamiske model (maks. dybde under hændelsen).',
  sameInputs: 'Begge forslag er beregnet med samme regnhændelse, afløbs- og jordforudsætninger og cellestørrelse, så forskellene nedenfor skyldes projektet (terræn, overflader, bygninger).',
  inputsDiffer: 'OBS: forslagene er IKKE beregnet med samme input ({list}). Forskellene i resultaterne skyldes både disse ændringer og projektet.',
  sideBySideNote: 'Samme farveskala og udsnit for alle forslag.',
  diffStatsWetter: 'Areal der er vådere i {b} (1 cm eller mere)', diffStatsDrier: 'Areal der er tørrere i {b} (1 cm eller mere)', diffStatsMaxUp: 'Største lokale stigning', diffStatsMaxDown: 'Største lokale fald',
  diffStatsEdgeWetter: 'Vådere areal inden for {m} m af grundens afgrænsning', diffStatsEdgeDrier: 'Tørrere areal inden for {m} m af grundens afgrænsning',
  neighboursIntro: 'Myndigheder spørger typisk, om et projekt forværrer forholdene for naboer eller nedstrøms. Screeningen giver det samlede volumen, der forlader modellens rand, og hvordan dybden ændres nær randen. Den fordeler ikke udstrømningen på naboer og giver ikke et afstrømningshydrograf.',
  sumEvent: 'Begge forslag er vurderet for {event}: {depth} mm × klimafaktor {cf} = {design} mm regn på {area}.',
  sumPonded: 'Vand der samler sig på grunden er {va} m³ i {a} og {vb} m³ i {b}: {dir}.',
  sumOver10: 'Arealet med mere end 10 cm vand er {va} m² i {a} og {vb} m² i {b}: {dir}.',
  sumMax: 'Største vanddybde er {va} cm i {a} og {vb} cm i {b}.',
  sumLeaves: 'Vand der forlader grundens afgrænsning er {va} m³ i {a} og {vb} m³ i {b}: {dir}.',
  sumLeavesUp: 'I denne screening sender {b} mere vand over grundens afgrænsning end {a}. Det bør drøftes med myndigheden sammen med, hvor vandet løber hen.',
  sumLeavesDown: 'I denne screening sender {b} mindre vand over grundens afgrænsning end {a}.',
  sumLeavesSame: 'I denne screening er mængden af vand, der forlader grunden, stort set uændret.',
  sumEdge: 'Inden for {m} m af grundens afgrænsning er {wet} m² vådere og {dry} m² tørrere i {b} (1 cm eller mere).',
  sumStorage: 'Vejledende nødvendigt forsinkelsesvolumen er {va} m³ for {a} og {vb} m³ for {b}.',
  sumCaveat: 'Udsagnene beskriver alene screeningsresultater. De viser ikke, at et krav er opfyldt.',
  dirDown: 'et fald på {d} ({p} %)', dirUp: 'en stigning på {d} ({p} %)', dirSame: 'stort set uændret', dirNew: 'en stigning på {d} (fra nul)',
  sumSingle1: 'For {event} ({design} mm regn inkl. klimafaktor {cf}) giver screeningen {ponded} m³ vand, der samler sig på grunden, og {leaves} m³, der forlader grundens afgrænsning, af i alt {rain} m³ regn.',
  sumSingle2: 'Vand dybere end 10 cm dækker {a10} m²; største dybde er {max} cm.',
  sumSingle3: 'Den dynamiske kørsel giver en største hastighed på {v} m/s og {hz} m² med faregrad "farligt for nogle" eller højere (massebalancefejl {err} %).',
  sumSingle4: 'Vejledende nødvendigt forsinkelsesvolumen ved en afledning på {q} l/s/ha (T = {t} år) er {s} m³.',
  methodIntro: 'Cloudburst er et screeningsværktøj. Den samme Rust-motor kører i webappen og i Revit- og Rhino-plug-ins. Den fulde modelbeskrivelse, parametertabeller og kilder findes i docs/physics-permeability.md og docs/PRD.md i Cloudburst-repositoriet.',
  methodM1: 'Øjebliksmodel (M1): effektiv regn pr. celle = min(C·P, P − Ia) minus kloaktabet, hvor P er den dimensionerende regndybde, C materialets skybruds-afløbskoefficient (vægtet efter jorden) og Ia dets initialtab; priority-flood til at finde lavninger og fill–spill–merge; strømningsveje med flere strømningsretninger. Giver dybder når lavningerne er fyldt; ingen tid, hastighed eller faregrad.',
  methodM2: 'Dynamisk model (M2): lokal-inertielle 2D-lavvandsligninger (Bates m.fl. 2010, de Almeida m.fl. 2012) med regn på gridet, initialtab, modificeret Horton-nedsivning styret af den akkumulerede nedsivning, bærelagsmagasiner under permeabel belægning, drænasfalt og regnbede, der dræner til underjorden med jordens hastighed, og et ensartet kloaktab, med fuld massebalance.',
  methodRet: 'Forsinkelse (OUT-8): reduceret areal Σ C·A med administrative koefficienter og kasseregnsmetoden med en vejledende IDF-kurve.',
  assumptionsTitle: 'Væsentlige antagelser',
  assumptions: [
    'Bygninger er massive blokke på mindst 5 m; tagvand går til kloak, medmindre andet er angivet.',
    'Kloakken er repræsenteret som et ensartet initialtab på befæstede flader (34 mm fællessystem, 29 mm separatsystem), ikke som et ledningsnet. Lokale svage punkter i kloakken ses ikke.',
    'Modellens rande er åbne: vand der når randen forlader modellen. Vand der løber ind på grunden udefra (uden for modelområdet) er ikke med.',
    'Jorden er én type for hele grunden (JB-6 hvis ikke andet er sat); nedsivning på komprimeret byjord er usikker med en faktor 3–8.',
    'Regnen falder jævnt over grunden. Regndybder er fra en vejledende IDF-kurve, ikke fra Spildevandskomiteens aktuelle værktøj.',
    'Terrænet er gensamplet til cellestørrelsen; kantsten, rør, underføringer og brodæk, der ikke er repræsenteret i gridet, ændrer strømningsvejene.',
  ],
  limitationsTitle: 'Begrænsninger',
  limitations: [
    'Resultaterne er screeningsresultater til sammenligning af forslag, ikke dokumentation til myndighedsgodkendelse eller overholdelse af krav.',
    'Ingen kobling til en afløbsmodel (planlagt M3); opstuvning fra kloak er ikke modelleret.',
    'Endnu ingen ensemble eller usikkerhedsintervaller (SIM-7); enkeltstående deterministiske kørsler.',
    'Udstrømning over randen er en total for grunden; den fordeles ikke på naboer, og der laves ikke et hydrograf.',
    'Facadeflag, målepunkter og GeoTIFF-eksport (OUT-5, OUT-6, OUT-10) er ikke med i rapporten.',
    'Ikke kalibreret mod en referencemodel (MIKE, SCALGO Live) for denne grund.',
    'Ingen genetablering af nedsivningsevnen mellem regnbyger: jord og bærelag fyldes kun under hændelsen. Dækkende for én dimensionerende regn på nogle timer, ikke for en serie af regnhændelser.',
    'Høj grundvandsstand er ikke repræsenteret. Motoren kan begrænse nedsivningen pr. celle, men det kræver grundvandsdata, som værktøjet ikke har; som standard anvendes ingen begrænsning.',
    'Øjebliksmodellen (afløbskoefficienter) og den dynamiske model (Horton-nedsivning fra JB-jordtabellen) kan give meget forskellige resultater på jordflader som græsplæner; på befæstede flader stemmer de godt overens. Brug den dynamiske model til tal, der afhænger af nedsivning.',
    'Regnens spidsintensitet: CDS-regnen bruger blokke på 1 minut (T = 100: ca. 457 mm/t med klimafaktor 1,4). På eksempelgrunde ændrede en top på 5 eller 10 minutter nedsivningen og vandet, der forlader grunden, med under 1 %, men arealet dybere end 10 cm med op til 9 %; resultater knyttet til toppen er mest følsomme for dette valg.',
  ],
  validationIntro: 'Automatiske test i motoren (status som angivet i repositoriets README for denne version). Der er ikke lavet en stedsspecifik validering.',
  validation: [
    ['Sø i hvile', 'Bestået: hastigheder under 1e-4 m/s'],
    ['Skrå flade mod kinematisk bølge', 'Inden for 15 % (PRD-mål er 5 % på udløb)'],
    ['Massebalance med regn på gridet', 'Bestået: fejl ca. 1e-6 (mål 0,1 %)'],
    ['Fyldning af lavninger (EA Test 2-type)', 'Bestået: volumen bevaret, vandrette niveauer'],
    ['M1 fill–spill bevarelse og kaskader', 'Bestået'],
    ['Forsinkelse mod håndberegning', 'Bestået'],
    ['EA Test 8A, sammenligning med SCALGO Live', 'Ikke udført: kræver referencedata / testgrund'],
  ],
  appEngine: 'Motorversion', appTool: 'Værktøj', appSchema: 'Rapportens dataskema', appBasis: 'Resultatgrundlag', appCreated: 'Forslag gemt', appGridDims: 'Grid (kolonner × rækker)',
  appCaption: 'Kortets billedtekst (OUT-9)', appParamsNote: 'Alle værdier er dem, appen havde, da rapporten blev genereret. Rapportens data (JSON) kan eksporteres fra samme dialog til arkivering.',
  units: { m3: 'm³', m2: 'm²', cm: 'cm', mm: 'mm', ls: 'l/s', lsha: 'l/s/ha', ms: 'm/s', pct: '%', min: 'min', m: 'm', h: 't', ha: 'ha' },
  presetNames: { t10: 'T = 10 år', t100: 'T = 100 år (skybrud)', test2011: '2011-test (København 2. juli 2011)', box83: 'Kasseregn 83 mm / 4 t' },
  shapeCds: 'Chicago-regn (CDS, alternerende blokke)', shapeBox: 'Kasseregn (konstant intensitet)',
  dlgTitle: 'Eksportér rapport (PDF)', dlgType: 'Rapporttype', dlgSingle: 'Ét resultat', dlgCompare: 'Sammenlign forslag', dlgSource: 'Resultat',
  dlgCurrent: 'Aktuelt resultat', dlgOptions: 'Forslag der sammenlignes (første afkrydsede = basis A)', dlgNoOptions: 'Gem først mindst to forslag: trin 5 “Compare designs” → “Save as option A”, ændr en overflade eller regnen, og gem “option B”. Et før/efter-eksempel kan også bruge “Compare with …”.',
  dlgSaveCurrent: 'Gem aktuelt resultat som forslag', dlgTerrainDatePh: 'fx DHM/Terræn 2023 eller opmålingsdato', dlgLanguage: 'Sprog', dlgDownload: 'Hent PDF', dlgJson: 'Rapportdata (JSON)', dlgCancel: 'Annullér',
  dlgWorking: 'Laver rapport…', dlgDone: 'Rapporten er gemt.', dlgProject: 'Projektoplysninger (trykkes på hver side)', dlgNotesPh: 'Fri tekst, fx hvad der er ændret mellem forslagene, åbne spørgsmål til myndigheden.',
  dlgDisclaimer: 'Rapporten er en gennemsigtig screeningsrapport. Den bærer altid teksten “resultaterne er til sammenligning af forslag, ikke dokumentation til myndighedsgodkendelse eller overholdelse af krav”.',
};

export const STRINGS = { en: EN, da: DA };
export const LANGS = [{ id: 'en', label: 'English' }, { id: 'da', label: 'Dansk' }];

/** Translator for one language: t('key', {vars}) with {name} placeholders. Falls back to English. */
export function translator(lang) {
  const L = STRINGS[lang] || EN;
  const t = (key, vars) => {
    let s = key in L ? L[key] : (key in EN ? EN[key] : key);
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return s;
  };
  t.lang = STRINGS[lang] ? lang : 'en';
  t.raw = L;
  return t;
}

/** Number formatters for one language. Danish uses decimal comma and '.' thousands. */
export function numberFormat(lang) {
  const loc = lang === 'da' ? 'da-DK' : 'en-GB';
  const cache = new Map();
  const nf = (d) => { if (!cache.has(d)) cache.set(d, new Intl.NumberFormat(loc, { minimumFractionDigits: d, maximumFractionDigits: d })); return cache.get(d); };
  /** Smart rounding: integers above 100, one decimal 10–100, two below. */
  const smart = (v) => {
    if (v == null || !isFinite(v)) return '–';
    if (Math.abs(v) < 0.005) v = 0; // never print "-0
    const a = Math.abs(v);
    return clean(nf(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 1 : a === 0 ? 0 : 2).format(v));
  };
  const fixed = (v, d = 0) => (v == null || !isFinite(v) ? '–' : clean(nf(d).format(Math.abs(v) < 0.5 * 10 ** -d ? 0 : v))); // no "-0"
  const signed = (v, f = smart) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '-' : '±') + f(Math.abs(v)));
  return { smart, fixed, signed, locale: loc };
}

/** Intl may emit U+2212 minus or narrow no-break spaces; the PDF standard fonts (WinAnsi) cannot show them. */
function clean(s) { return s.replace(/−/g, '-').replace(/[  ]/g, ' '); }
