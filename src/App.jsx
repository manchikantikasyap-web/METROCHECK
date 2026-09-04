import { useEffect, useMemo, useState } from "react";
import { createWorker } from "tesseract.js";
import { jsPDF } from "jspdf";
import "./App.css";

const HISTORY_KEY = "metrocheck_inspections_v6";

const EMPTY_FIELDS = {
  manufacturer: "",
  importer: "",
  countryOfOrigin: "",
  productName: "",
  netQuantity: "",
  manufactureDate: "",
  bestBefore: "",
  mrp: "",
  consumerCare: "",
  dimensions: "",
  unitSalePrice: "",
};

const RULES = [
  {
    id: "manufacturer",
    title: "Manufacturer / Packer / Importer",
    short: "Responsible entity declaration",
    description:
      "The package should identify the manufacturer, packer or importer as applicable.",
    severity: "High",
    check: (f) => Boolean(f.manufacturer || f.importer),
  },
  {
    id: "origin",
    title: "Country of Origin",
    short: "Origin declaration",
    description:
      "Imported commodities should carry the applicable country-of-origin declaration.",
    severity: "High",
    check: (f) => Boolean(f.countryOfOrigin),
  },
  {
    id: "generic",
    title: "Common / Generic Name",
    short: "Commodity identification",
    description:
      "The common or generic name of the commodity should be identifiable.",
    severity: "Medium",
    check: (f) => Boolean(f.productName),
  },
  {
    id: "quantity",
    title: "Net Quantity",
    short: "Quantity declaration",
    description:
      "The package should declare its net quantity in an appropriate unit.",
    severity: "Critical",
    check: (f) => Boolean(f.netQuantity),
  },
  {
    id: "date",
    title: "Date of Manufacture / Packing",
    short: "Manufacturing information",
    description:
      "Applicable manufacturing or packing date information should be declared.",
    severity: "Medium",
    check: (f) => Boolean(f.manufactureDate),
  },
  {
    id: "bestBefore",
    title: "Best Before / Use By",
    short: "Validity information",
    description:
      "Where applicable, the package should declare the relevant best-before or use-by information.",
    severity: "High",
    check: (f) => Boolean(f.bestBefore),
  },
  {
    id: "mrp",
    title: "Maximum Retail Price",
    short: "MRP inclusive of taxes",
    description:
      "The applicable maximum retail price should be identifiable on the package.",
    severity: "Critical",
    check: (f) => Boolean(f.mrp),
  },
  {
    id: "consumer",
    title: "Consumer Care Details",
    short: "Complaint contact information",
    description:
      "Consumer care/contact information should be available where applicable.",
    severity: "Medium",
    check: (f) => Boolean(f.consumerCare),
  },
  {
    id: "dimensions",
    title: "Dimensions",
    short: "Dimension declaration",
    description:
      "Dimensions should be declared for commodities where the rule requires them.",
    severity: "Low",
    check: (f) => Boolean(f.dimensions),
  },
  {
    id: "unitPrice",
    title: "Unit Sale Price",
    short: "Unit price declaration",
    description:
      "Unit sale price is checked where applicable to the package category.",
    severity: "Medium",
    check: (f) => Boolean(f.unitSalePrice),
  },
];

const FIELD_CONFIG = [
  ["manufacturer", "Manufacturer / Packer", "e.g. ABC Foods Pvt. Ltd."],
  ["importer", "Importer", "e.g. ABC Imports"],
  ["countryOfOrigin", "Country of Origin", "e.g. India"],
  ["productName", "Common / Generic Name", "e.g. Basmati Rice"],
  ["netQuantity", "Net Quantity", "e.g. 1 kg"],
  ["manufactureDate", "Manufacture / Packing Date", "e.g. 08/2026"],
  ["bestBefore", "Best Before / Use By", "e.g. Best Before 12 Months"],
  ["mrp", "MRP", "e.g. ₹120.00"],
  ["consumerCare", "Consumer Care", "e.g. 1800-XXX-XXXX"],
  ["dimensions", "Dimensions", "e.g. 20 cm × 12 cm"],
  ["unitSalePrice", "Unit Sale Price", "e.g. ₹120/kg"],
];

function normalizeText(value = "") {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDate(date = new Date()) {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function makeInspectionId() {
  const d = new Date();
  const stamp =
    String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const random = Math.floor(1000 + Math.random() * 9000);
  return `MC-${stamp}-${random}`;
}

function findMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractFields(rawText) {
  const text = normalizeText(rawText);
  const lower = text.toLowerCase();

  const fields = {
    ...EMPTY_FIELDS,

    manufacturer: findMatch(text, [
      /(?:manufactured by|manufacturer|manufactured\/packed by|packed by)\s*[:\-]?\s*([^\n]+)/i,
      /(?:mfg\.?|mfd\.?)\s*(?:by)?\s*[:\-]?\s*([^\n]+)/i,
    ]),

    importer: findMatch(text, [
      /(?:imported by|importer)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    countryOfOrigin: findMatch(text, [
      /(?:country of origin|origin)\s*[:\-]?\s*([^\n]+)/i,
      /(?:made in)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    productName: findMatch(text, [
      /(?:product name|common name|generic name)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    netQuantity:
      findMatch(text, [
        /(?:net quantity|net qty|net weight|net wt\.?)\s*[:\-]?\s*([^\n]+)/i,
      ]) ||
      (text.match(/\b\d+(?:\.\d+)?\s?(?:kg|g|mg|ml|l|litre|liter)\b/i) || [
        "",
      ])[0],

    manufactureDate: findMatch(text, [
      /(?:date of manufacture|date of mfg|mfg\.?\s*date|packed on|packing date|date of packing)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    bestBefore: findMatch(text, [
      /(?:best before|use by|expiry|expires)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    mrp:
      findMatch(text, [
        /(?:mrp|maximum retail price)\s*[:\-]?\s*(₹?\s?[\d,.]+)/i,
      ]) ||
      (text.match(/(?:₹|rs\.?|inr)\s?[\d,.]+/i) || [""])[0],

    consumerCare: findMatch(text, [
      /(?:consumer care|customer care|helpline|toll free|contact us)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    dimensions: findMatch(text, [
      /(?:dimensions|dimension|size)\s*[:\-]?\s*([^\n]+)/i,
    ]),

    unitSalePrice: findMatch(text, [
      /(?:unit sale price|unit price|price per)\s*[:\-]?\s*([^\n]+)/i,
    ]),
  };

  if (!fields.productName) {
    const lines = text
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.length > 3);

    fields.productName =
      lines.find(
        (line) =>
          !/mrp|manufact|packed|import|country|quantity|best before|expiry|consumer|fssai|batch|date/i.test(
            line
          )
      ) || "";
  }

  if (!fields.countryOfOrigin && lower.includes("made in india")) {
    fields.countryOfOrigin = "India";
  }

  return fields;
}

function runCompliance(fields, physicalQuantity) {
  const results = RULES.map((rule) => {
    const passed = rule.check(fields);

    return {
      ...rule,
      status: passed ? "PASS" : "FAIL",
      message: passed
        ? "Required information appears to be present."
        : "Required information could not be identified from the scanned declaration.",
    };
  });

  if (physicalQuantity !== "" && Number(physicalQuantity) > 0) {
    const declared = parseFloat(
      String(fields.netQuantity).replace(/[^\d.]/g, "")
    );

    if (declared > 0) {
      const tolerance = declared * 0.02;
      const difference = Math.abs(Number(physicalQuantity) - declared);

      const quantityRule = results.find((x) => x.id === "quantity");

      if (quantityRule) {
        if (difference <= tolerance) {
          quantityRule.status = "PASS";
          quantityRule.message =
            "Declared quantity is present and the inspector-entered measured quantity is within the demonstration tolerance.";
        } else {
          quantityRule.status = "FAIL";
          quantityRule.message =
            "Inspector-entered measured quantity differs materially from the declared quantity.";
        }
      }
    }
  }

  return results;
}

function scoreResults(results) {
  if (!results.length) return 0;
  return Math.round(
    (results.filter((r) => r.status === "PASS").length / results.length) * 100
  );
}

function overallStatus(results) {
  if (!results.length) return "NOT SCANNED";
  const failures = results.filter((r) => r.status === "FAIL").length;

  if (failures === 0) return "COMPLIANT";
  if (failures <= 2) return "REVIEW REQUIRED";
  return "NON-COMPLIANT";
}

function Icon({ name, size = 20 }) {
  const icons = {
    grid: "▦",
    scan: "⌁",
    history: "◷",
    info: "ⓘ",
    settings: "⚙",
    moon: "☾",
    sun: "☀",
    upload: "↑",
    camera: "▣",
    check: "✓",
    close: "×",
    arrow: "→",
    file: "▤",
    shield: "◇",
    warning: "!",
    search: "⌕",
    trash: "⌫",
    download: "↓",
    refresh: "↻",
    user: "●",
    plus: "+",
  };

  return (
    <span
      className="icon"
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      {icons[name] || "•"}
    </span>
  );
}

function StatusBadge({ status }) {
  const normalized = status.toLowerCase().replace(/\s/g, "-");

  return (
    <span className={`status-badge status-${normalized}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function EmptyState({ icon = "file", title, text, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function App() {
  const [page, setPage] = useState("dashboard");
  const [darkMode, setDarkMode] = useState(false);

  const [inspectionId, setInspectionId] = useState(makeInspectionId());
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [fields, setFields] = useState({ ...EMPTY_FIELDS });
  const [ruleResults, setRuleResults] = useState([]);
  const [physicalQuantity, setPhysicalQuantity] = useState("");
  const [evidence, setEvidence] = useState([]);
  const [decision, setDecision] = useState("");
  const [notes, setNotes] = useState("");

  const [scanState, setScanState] = useState("idle");
  const [scanProgress, setScanProgress] = useState(0);
  const [toast, setToast] = useState("");

  const [history, setHistory] = useState([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyFilter, setHistoryFilter] = useState("ALL");

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (Array.isArray(saved)) setHistory(saved);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    document.body.className = darkMode ? "dark-mode" : "";
  }, [darkMode]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const results = useMemo(
    () => runCompliance(fields, physicalQuantity),
    [fields, physicalQuantity]
  );

  const score = useMemo(() => scoreResults(results), [results]);
  const status = useMemo(() => overallStatus(results), [results]);

  const passedCount = results.filter((r) => r.status === "PASS").length;
  const failedCount = results.filter((r) => r.status === "FAIL").length;

  const filteredHistory = useMemo(() => {
    return history.filter((item) => {
      const matchesSearch =
        !historySearch ||
        `${item.id} ${item.productName} ${item.status}`
          .toLowerCase()
          .includes(historySearch.toLowerCase());

      const matchesFilter =
        historyFilter === "ALL" || item.status === historyFilter;

      return matchesSearch && matchesFilter;
    });
  }, [history, historySearch, historyFilter]);

  function navigate(target) {
    setPage(target);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showToast(message) {
    setToast(message);
  }

  function resetInspection() {
    setInspectionId(makeInspectionId());
    setImageFile(null);
    setImagePreview("");
    setOcrText("");
    setFields({ ...EMPTY_FIELDS });
    setRuleResults([]);
    setPhysicalQuantity("");
    setEvidence([]);
    setDecision("");
    setNotes("");
    setScanState("idle");
    setScanProgress(0);
  }

  function startNewInspection() {
    resetInspection();
    navigate("scanner");
  }

  function handleImage(file) {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showToast("Please select an image file.");
      return;
    }

    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setScanState("ready");
    setOcrText("");
    setFields({ ...EMPTY_FIELDS });
    setRuleResults([]);
    showToast("Product image loaded.");
  }

  async function runOCR() {
    if (!imagePreview) {
      showToast("Upload a product image first.");
      return;
    }

    setScanState("scanning");
    setScanProgress(5);
    setOcrText("");

    try {
      const worker = await createWorker("eng");

      setScanProgress(20);

      const response = await worker.recognize(imagePreview);

      setScanProgress(80);

      const text = normalizeText(response?.data?.text || "");

      await worker.terminate();

      setOcrText(text);
      const extracted = extractFields(text);

      setFields(extracted);
      setRuleResults(runCompliance(extracted, physicalQuantity));
      setScanProgress(100);
      setScanState("complete");

      showToast("OCR scan completed successfully.");
    } catch (error) {
      console.error(error);
      setScanState("error");
      showToast("OCR could not process this image. You can enter fields manually.");
    }
  }

  function updateField(key, value) {
    setFields((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  function handleEvidence(files) {
    const list = Array.from(files || []).map((file) => ({
      id: `${file.name}-${file.lastModified}`,
      name: file.name,
      size: file.size,
      type: file.type,
    }));

    setEvidence((prev) => [...prev, ...list]);
    if (list.length) showToast(`${list.length} evidence file(s) added.`);
  }

  function removeEvidence(id) {
    setEvidence((prev) => prev.filter((item) => item.id !== id));
  }

  function saveInspection() {
    const finalResults = runCompliance(fields, physicalQuantity);
    const finalScore = scoreResults(finalResults);
    const finalStatus = decision || overallStatus(finalResults);

    const record = {
      id: inspectionId,
      productName: fields.productName || "Unknown commodity",
      imagePreview,
      fields,
      ocrText,
      physicalQuantity,
      evidence,
      decision: finalStatus,
      status: finalStatus,
      score: finalScore,
      ruleResults: finalResults,
      notes,
      date: formatDate(),
      time: formatTime(),
      timestamp: Date.now(),
    };

    const next = [
      record,
      ...history.filter((item) => item.id !== inspectionId),
    ];

    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));

    setDecision(finalStatus);
    showToast("Inspection saved to history.");
    navigate("history");
  }

  function loadInspection(record) {
    setInspectionId(record.id);
    setImagePreview(record.imagePreview || "");
    setFields(record.fields || { ...EMPTY_FIELDS });
    setOcrText(record.ocrText || "");
    setPhysicalQuantity(record.physicalQuantity || "");
    setEvidence(record.evidence || []);
    setDecision(record.decision || record.status || "");
    setNotes(record.notes || "");
    setRuleResults(record.ruleResults || []);
    setScanState(record.imagePreview ? "complete" : "idle");
    setScanProgress(record.imagePreview ? 100 : 0);
    navigate("scanner");
  }

  function deleteInspection(id) {
    const next = history.filter((item) => item.id !== id);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    showToast("Inspection removed.");
  }

  function clearHistory() {
    if (!history.length) return;
    const confirmed = window.confirm(
      "Delete all saved inspection history?"
    );
    if (!confirmed) return;

    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
    showToast("Inspection history cleared.");
  }

  function generatePDF() {
    const doc = new jsPDF();

    const margin = 16;
    let y = 18;

    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text("METROCHECK", margin, y);

    y += 8;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(
      "Packaged Commodity Legal Metrology Compliance Report",
      margin,
      y
    );

    y += 12;
    doc.setFontSize(11);
    doc.text(`Inspection ID: ${inspectionId}`, margin, y);
    y += 7;
    doc.text(`Date: ${formatDate()}`, margin, y);
    y += 7;
    doc.text(`Time: ${formatTime()}`, margin, y);

    y += 12;
    doc.setFont("helvetica", "bold");
    doc.text("Inspection Summary", margin, y);
    doc.setFont("helvetica", "normal");

    y += 8;
    doc.text(`Commodity: ${fields.productName || "Not identified"}`, margin, y);
    y += 7;
    doc.text(`Compliance Score: ${score}%`, margin, y);
    y += 7;
    doc.text(`System Status: ${status}`, margin, y);
    y += 7;
    doc.text(
      `Inspector Decision: ${decision || "Pending verification"}`,
      margin,
      y
    );

    y += 12;
    doc.setFont("helvetica", "bold");
    doc.text("Declaration Analysis", margin, y);
    doc.setFont("helvetica", "normal");

    y += 8;

    results.forEach((rule, index) => {
      if (y > 275) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");
      doc.text(`${index + 1}. ${rule.title}`, margin, y);

      y += 6;
      doc.setFont("helvetica", "normal");
      doc.text(`Status: ${rule.status}`, margin + 4, y);

      y += 6;

      const lines = doc.splitTextToSize(rule.message, 170);
      doc.text(lines, margin + 4, y);
      y += lines.length * 5 + 4;
    });

    if (physicalQuantity) {
      if (y > 260) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");
      doc.text("Physical Verification", margin, y);
      y += 7;
      doc.setFont("helvetica", "normal");
      doc.text(
        `Inspector-entered measured quantity: ${physicalQuantity}`,
        margin,
        y
      );
      y += 10;
    }

    if (notes) {
      if (y > 255) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");
      doc.text("Inspector Notes", margin, y);
      y += 7;
      doc.setFont("helvetica", "normal");

      const noteLines = doc.splitTextToSize(notes, 175);
      doc.text(noteLines, margin, y);
      y += noteLines.length * 5 + 10;
    }

    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");
    doc.text(
      "MetroCheck is a prototype decision-support system. Final enforcement decisions remain subject to inspector verification and applicable law.",
      margin,
      285
    );

    doc.save(`${inspectionId}-MetroCheck-Report.pdf`);
    showToast("PDF report generated.");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span>MC</span>
          </div>
          <div>
            <div className="brand-name">METROCHECK</div>
            <div className="brand-subtitle">LEGAL METROLOGY AI</div>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">WORKSPACE</div>

          <button
            className={`nav-item ${page === "dashboard" ? "active" : ""}`}
            onClick={() => navigate("dashboard")}
          >
            <Icon name="grid" />
            <span>Dashboard</span>
          </button>

          <button
            className={`nav-item ${page === "scanner" ? "active" : ""}`}
            onClick={() => navigate("scanner")}
          >
            <Icon name="scan" />
            <span>New Inspection</span>
          </button>

          <button
            className={`nav-item ${page === "history" ? "active" : ""}`}
            onClick={() => navigate("history")}
          >
            <Icon name="history" />
            <span>Inspection History</span>
            {history.length > 0 && (
              <span className="nav-count">{history.length}</span>
            )}
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">SYSTEM</div>

          <button
            className={`nav-item ${page === "about" ? "active" : ""}`}
            onClick={() => navigate("about")}
          >
            <Icon name="info" />
            <span>About MetroCheck</span>
          </button>
        </div>

        <div className="sidebar-bottom">
          <div className="system-card">
            <div className="system-card-icon">
              <Icon name="shield" size={22} />
            </div>
            <div>
              <strong>Inspection Engine</strong>
              <span>Operational</span>
            </div>
            <span className="online-dot" />
          </div>

          <button
            className="theme-button"
            onClick={() => setDarkMode((prev) => !prev)}
          >
            <Icon name={darkMode ? "sun" : "moon"} />
            <span>{darkMode ? "Light Mode" : "Dark Mode"}</span>
          </button>

          <div className="profile-mini">
            <div className="avatar">I</div>
            <div>
              <strong>Inspector</strong>
              <span>Field Operator</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <div className="breadcrumb">
              <span>MetroCheck</span>
              <span className="breadcrumb-separator">/</span>
              <strong>
                {page === "dashboard"
                  ? "Dashboard"
                  : page === "scanner"
                  ? "New Inspection"
                  : page === "history"
                  ? "Inspection History"
                  : "About"}
              </strong>
            </div>
          </div>

          <div className="topbar-right">
            <div className="secure-status">
              <span className="online-dot" />
              System Online
            </div>

            <button className="icon-button" title="Settings">
              <Icon name="settings" size={19} />
            </button>

            <div className="top-avatar">I</div>
          </div>
        </header>

        {page === "dashboard" && (
          <DashboardPage
            history={history}
            onNewInspection={startNewInspection}
            onOpenHistory={() => navigate("history")}
            onOpenInspection={loadInspection}
          />
        )}

        {page === "scanner" && (
          <ScannerPage
            inspectionId={inspectionId}
            imagePreview={imagePreview}
            imageFile={imageFile}
            scanState={scanState}
            scanProgress={scanProgress}
            ocrText={ocrText}
            fields={fields}
            results={results}
            score={score}
            status={status}
            passedCount={passedCount}
            failedCount={failedCount}
            physicalQuantity={physicalQuantity}
            evidence={evidence}
            decision={decision}
            notes={notes}
            onImage={handleImage}
            onScan={runOCR}
            onField={updateField}
            onPhysicalQuantity={setPhysicalQuantity}
            onEvidence={handleEvidence}
            onRemoveEvidence={removeEvidence}
            onDecision={setDecision}
            onNotes={setNotes}
            onSave={saveInspection}
            onPDF={generatePDF}
            onReset={resetInspection}
          />
        )}

        {page === "history" && (
          <HistoryPage
            history={filteredHistory}
            allHistory={history}
            search={historySearch}
            filter={historyFilter}
            onSearch={setHistorySearch}
            onFilter={setHistoryFilter}
            onOpen={loadInspection}
            onDelete={deleteInspection}
            onClear={clearHistory}
            onNew={startNewInspection}
          />
        )}

        {page === "about" && <AboutPage />}
      </main>

      {toast && (
        <div className="toast">
          <div className="toast-icon">
            <Icon name="check" size={16} />
          </div>
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

function DashboardPage({
  history,
  onNewInspection,
  onOpenHistory,
  onOpenInspection,
}) {
  const compliant = history.filter((x) => x.status === "COMPLIANT").length;
  const nonCompliant = history.filter(
    (x) => x.status === "NON-COMPLIANT"
  ).length;
  const review = history.filter(
    (x) => x.status === "REVIEW REQUIRED"
  ).length;

  const recent = history.slice(0, 5);

  return (
    <div className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">LEGAL METROLOGY • INSPECTION WORKSPACE</div>
          <h1>
            Inspect smarter.
            <br />
            <span>Decide with evidence.</span>
          </h1>
          <p>
            Scan packaged commodity labels, identify mandatory declarations,
            analyze compliance requirements and create an inspection-ready
            report.
          </p>

          <div className="hero-actions">
            <button className="primary-button large" onClick={onNewInspection}>
              <Icon name="scan" size={21} />
              Start New Inspection
              <Icon name="arrow" size={19} />
            </button>

            <button className="secondary-button large" onClick={onOpenHistory}>
              <Icon name="history" size={19} />
              View History
            </button>
          </div>
        </div>

        <div className="hero-visual">
          <div className="scanner-orbit orbit-one" />
          <div className="scanner-orbit orbit-two" />
          <div className="scanner-core">
            <div className="core-line" />
            <Icon name="shield" size={38} />
            <strong>METRO</strong>
            <span>CHECK</span>
          </div>
          <div className="floating-chip chip-one">OCR</div>
          <div className="floating-chip chip-two">RULE ENGINE</div>
          <div className="floating-chip chip-three">REPORT</div>
        </div>
      </section>

      <section className="section-heading">
        <div>
          <span className="eyebrow">OVERVIEW</span>
          <h2>Inspection intelligence</h2>
        </div>
        <span className="section-date">{formatDate()}</span>
      </section>

      <div className="stat-grid">
        <StatCard
          label="Total Inspections"
          value={history.length}
          caption="Saved in this browser"
          icon="file"
          tone="blue"
        />
        <StatCard
          label="Compliant"
          value={compliant}
          caption="Passed all checks"
          icon="check"
          tone="green"
        />
        <StatCard
          label="Non-Compliant"
          value={nonCompliant}
          caption="Violations identified"
          icon="warning"
          tone="red"
        />
        <StatCard
          label="Review Required"
          value={review}
          caption="Needs inspector review"
          icon="search"
          tone="amber"
        />
      </div>

      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-header">
            <div>
              <span className="panel-kicker">ACTIVITY</span>
              <h3>Recent inspections</h3>
            </div>
            <button className="text-button" onClick={onOpenHistory}>
              View all <Icon name="arrow" size={16} />
            </button>
          </div>

          {recent.length === 0 ? (
            <EmptyState
              icon="scan"
              title="No inspections yet"
              text="Start your first packaged commodity inspection to see activity here."
              action={
                <button className="secondary-button" onClick={onNewInspection}>
                  Start Inspection
                </button>
              }
            />
          ) : (
            <div className="activity-list">
              {recent.map((item) => (
                <button
                  className="activity-row"
                  key={item.id}
                  onClick={() => onOpenInspection(item)}
                >
                  <div className="activity-icon">
                    <Icon name="scan" size={18} />
                  </div>

                  <div className="activity-main">
                    <strong>{item.productName}</strong>
                    <span>
                      {item.id} • {item.date} • {item.time}
                    </span>
                  </div>

                  <div className="activity-score">
                    <strong>{item.score}%</strong>
                    <span>score</span>
                  </div>

                  <StatusBadge status={item.status} />

                  <Icon name="arrow" size={17} />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel methodology-panel">
          <div className="panel-header">
            <div>
              <span className="panel-kicker">WORKFLOW</span>
              <h3>How MetroCheck works</h3>
            </div>
          </div>

          <div className="workflow-list">
            <WorkflowStep
              number="01"
              title="Capture"
              text="Upload a clear image of the package or label."
            />
            <WorkflowStep
              number="02"
              title="Extract"
              text="OCR identifies visible declarations and values."
            />
            <WorkflowStep
              number="03"
              title="Analyze"
              text="The rule engine maps extracted data to checks."
            />
            <WorkflowStep
              number="04"
              title="Verify"
              text="Inspector reviews evidence and physical quantity."
            />
            <WorkflowStep
              number="05"
              title="Report"
              text="Generate a structured inspection report."
            />
          </div>
        </section>
      </div>

      <section className="info-strip">
        <div className="info-strip-icon">
          <Icon name="shield" size={22} />
        </div>
        <div>
          <strong>Inspector-first design</strong>
          <p>
            OCR and automated checks assist the inspector. Physical
            measurements remain inspector-entered and final enforcement
            decisions remain subject to verification.
          </p>
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, caption, icon, tone }) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <div className="stat-top">
        <div className="stat-icon">
          <Icon name={icon} size={19} />
        </div>
        <span>{label}</span>
      </div>

      <div className="stat-value">{value}</div>
      <div className="stat-caption">{caption}</div>
    </div>
  );
}

function WorkflowStep({ number, title, text }) {
  return (
    <div className="workflow-step">
      <div className="workflow-number">{number}</div>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function ScannerPage({
  inspectionId,
  imagePreview,
  imageFile,
  scanState,
  scanProgress,
  ocrText,
  fields,
  results,
  score,
  status,
  passedCount,
  failedCount,
  physicalQuantity,
  evidence,
  decision,
  notes,
  onImage,
  onScan,
  onField,
  onPhysicalQuantity,
  onEvidence,
  onRemoveEvidence,
  onDecision,
  onNotes,
  onSave,
  onPDF,
  onReset,
}) {
  const [showOCR, setShowOCR] = useState(false);

  return (
    <div className="page scanner-page">
      <PageTitle
        eyebrow="INSPECTION WORKSPACE"
        title="New packaged commodity inspection"
        text={`Inspection ID ${inspectionId} • Capture, analyze and verify a package.`
        }
        action={
          <button className="secondary-button" onClick={onReset}>
            <Icon name="refresh" size={17} />
            Reset
          </button>
        }
      />

      <div className="inspection-progress">
        <ProgressStep number="01" title="Capture" active={!!imagePreview} />
        <div className="progress-line" />
        <ProgressStep
          number="02"
          title="OCR & Extract"
          active={scanState === "complete"}
        />
        <div className="progress-line" />
        <ProgressStep
          number="03"
          title="Compliance"
          active={results.length > 0}
        />
        <div className="progress-line" />
        <ProgressStep
          number="04"
          title="Verify & Report"
          active={!!decision}
        />
      </div>

      <section className="scanner-layout">
        <div className="scanner-left">
          <div className="panel scanner-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">STEP 01</span>
                <h3>Product / label image</h3>
              </div>

              {scanState === "complete" && (
                <StatusBadge status="SCAN COMPLETE" />
              )}
            </div>

            {!imagePreview ? (
              <label className="upload-zone">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => onImage(e.target.files?.[0])}
                />

                <div className="upload-icon">
                  <Icon name="upload" size={28} />
                </div>

                <h3>Drop package image here</h3>
                <p>
                  Upload a clear photograph of the front, back or declaration
                  panel.
                </p>

                <span className="upload-button">
                  <Icon name="upload" size={17} />
                  Choose Image
                </span>

                <small>JPG, PNG or WEBP • Clear text recommended</small>
              </label>
            ) : (
              <div className="image-preview-wrap">
                <img
                  src={imagePreview}
                  alt="Uploaded packaged commodity"
                  className="product-image"
                />

                <div className="image-overlay">
                  <span>{imageFile?.name || "Inspection image"}</span>

                  <label className="change-image">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => onImage(e.target.files?.[0])}
                    />
                    Change image
                  </label>
                </div>
              </div>
            )}

            {imagePreview && (
              <div className="scan-action-row">
                <div className="file-meta">
                  <div className="file-meta-icon">
                    <Icon name="file" size={18} />
                  </div>
                  <div>
                    <strong>{imageFile?.name || "Package image"}</strong>
                    <span>
                      {imageFile?.size
                        ? `${(imageFile.size / 1024 / 1024).toFixed(2)} MB`
                        : "Loaded inspection image"}
                    </span>
                  </div>
                </div>

                <button
                  className="primary-button"
                  onClick={onScan}
                  disabled={scanState === "scanning"}
                >
                  <Icon
                    name={scanState === "scanning" ? "refresh" : "scan"}
                    size={18}
                  />
                  {scanState === "scanning"
                    ? "Scanning..."
                    : scanState === "complete"
                    ? "Scan Again"
                    : "Run OCR Scan"}
                </button>
              </div>
            )}

            {scanState === "scanning" && (
              <div className="scan-progress-box">
                <div className="scan-progress-top">
                  <span>Analyzing package image</span>
                  <strong>{scanProgress}%</strong>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${scanProgress}%` }}
                  />
                </div>
                <span>
                  OCR is identifying text and declaration patterns. This may
                  take a few moments.
                </span>
              </div>
            )}

            {scanState === "error" && (
              <div className="error-box">
                <div className="error-icon">
                  <Icon name="warning" size={18} />
                </div>
                <div>
                  <strong>OCR processing failed</strong>
                  <p>
                    You can continue by entering the declaration fields
                    manually.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">STEP 02</span>
                <h3>Extracted declarations</h3>
              </div>

              <button
                className="text-button"
                onClick={() => setShowOCR((prev) => !prev)}
              >
                {showOCR ? "Hide OCR text" : "View raw OCR"}
              </button>
            </div>

            {showOCR && (
              <div className="ocr-box">
                {ocrText || "No OCR text available yet."}
              </div>
            )}

            <div className="field-grid">
              {FIELD_CONFIG.map(([key, label, placeholder]) => (
                <div className="field" key={key}>
                  <label>{label}</label>
                  <input
                    value={fields[key]}
                    onChange={(e) => onField(key, e.target.value)}
                    placeholder={placeholder}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">STEP 03</span>
                <h3>Compliance analysis</h3>
              </div>

              {results.length > 0 && <StatusBadge status={status} />}
            </div>

            {results.length === 0 ? (
              <EmptyState
                icon="search"
                title="Compliance analysis waiting"
                text="Run OCR or enter declaration information to activate the rule analysis."
              />
            ) : (
              <>
                <div className="compliance-summary">
                  <div className="score-ring">
                    <div>
                      <strong>{score}</strong>
                      <span>%</span>
                    </div>
                  </div>

                  <div className="compliance-summary-copy">
                    <span className="panel-kicker">AUTOMATED SCREENING</span>
                    <h3>{status}</h3>
                    <p>
                      {passedCount} checks passed and {failedCount} checks
                      require attention.
                    </p>
                  </div>

                  <div className="mini-stat">
                    <strong>{passedCount}</strong>
                    <span>Passed</span>
                  </div>

                  <div className="mini-stat danger">
                    <strong>{failedCount}</strong>
                    <span>Failed</span>
                  </div>
                </div>

                <div className="rule-list">
                  {results.map((rule) => (
                    <RuleCard rule={rule} key={rule.id} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="scanner-right">
          <div className="panel sticky-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">LIVE RESULT</span>
                <h3>Inspection status</h3>
              </div>
            </div>

            <div className={`result-hero result-${status.toLowerCase().replaceAll(" ", "-")}`}>
              <div className="result-icon">
                <Icon
                  name={
                    status === "COMPLIANT"
                      ? "check"
                      : status === "NON-COMPLIANT"
                      ? "warning"
                      : "search"
                  }
                  size={25}
                />
              </div>

              <div>
                <span>Current assessment</span>
                <strong>{status}</strong>
              </div>
            </div>

            <div className="result-score-row">
              <div>
                <span>Compliance score</span>
                <strong>{score}%</strong>
              </div>

              <div className="score-bar">
                <div
                  style={{ width: `${score}%` }}
                  className="score-bar-fill"
                />
              </div>
            </div>

            <div className="summary-list">
              <SummaryLine label="Rules evaluated" value={results.length} />
              <SummaryLine label="Passed" value={passedCount} good />
              <SummaryLine label="Attention required" value={failedCount} bad />
              <SummaryLine
                label="Evidence files"
                value={evidence.length}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">PHYSICAL CHECK</span>
                <h3>Inspector verification</h3>
              </div>
            </div>

            <div className="inspector-note">
              <Icon name="info" size={18} />
              <span>
                Physical quantity must be entered by the inspector. It is not
                estimated from the image.
              </span>
            </div>

            <div className="field">
              <label>Measured quantity</label>
              <div className="input-with-suffix">
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={physicalQuantity}
                  onChange={(e) => onPhysicalQuantity(e.target.value)}
                  placeholder="Enter measured quantity"
                />
                <span>actual</span>
              </div>
            </div>

            <div className="decision-block">
              <label>Inspector decision</label>

              <div className="decision-options">
                {[
                  ["COMPLIANT", "check"],
                  ["NON-COMPLIANT", "warning"],
                  ["REVIEW REQUIRED", "search"],
                ].map(([value, icon]) => (
                  <button
                    key={value}
                    className={`decision-option ${
                      decision === value ? "selected" : ""
                    }`}
                    onClick={() => onDecision(value)}
                  >
                    <Icon name={icon} size={16} />
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Inspector notes</label>
              <textarea
                value={notes}
                onChange={(e) => onNotes(e.target.value)}
                placeholder="Record observations, verification notes or additional findings..."
                rows={5}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">EVIDENCE</span>
                <h3>Supporting files</h3>
              </div>
            </div>

            <label className="evidence-upload">
              <input
                type="file"
                multiple
                accept="image/*,.pdf"
                onChange={(e) => onEvidence(e.target.files)}
              />
              <Icon name="upload" size={20} />
              <span>
                <strong>Add evidence</strong>
                <small>Photos or PDF documents</small>
              </span>
            </label>

            {evidence.length > 0 && (
              <div className="evidence-list">
                {evidence.map((item) => (
                  <div className="evidence-item" key={item.id}>
                    <div className="evidence-file-icon">
                      <Icon name="file" size={16} />
                    </div>
                    <div>
                      <strong>{item.name}</strong>
                      <span>
                        {(item.size / 1024).toFixed(0)} KB
                      </span>
                    </div>
                    <button onClick={() => onRemoveEvidence(item.id)}>
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="final-actions">
            <button className="secondary-button" onClick={onPDF}>
              <Icon name="download" size={18} />
              Generate PDF
            </button>

            <button className="primary-button large" onClick={onSave}>
              <Icon name="check" size={18} />
              Save Inspection
              <Icon name="arrow" size={18} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PageTitle({ eyebrow, title, text, action }) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>

      {action}
    </div>
  );
}

function ProgressStep({ number, title, active }) {
  return (
    <div className={`progress-step ${active ? "active" : ""}`}>
      <span>{number}</span>
      <strong>{title}</strong>
    </div>
  );
}

function RuleCard({ rule }) {
  return (
    <div className={`rule-card rule-${rule.status.toLowerCase()}`}>
      <div className="rule-status-icon">
        <Icon
          name={rule.status === "PASS" ? "check" : "warning"}
          size={17}
        />
      </div>

      <div className="rule-content">
        <div className="rule-title-row">
          <div>
            <strong>{rule.title}</strong>
            <span>{rule.short}</span>
          </div>

          <div className="rule-right">
            <span className={`severity severity-${rule.severity.toLowerCase()}`}>
              {rule.severity}
            </span>
            <StatusBadge status={rule.status} />
          </div>
        </div>

        <p>{rule.message}</p>
      </div>
    </div>
  );
}

function SummaryLine({ label, value, good, bad }) {
  return (
    <div className="summary-line">
      <span>{label}</span>
      <strong className={good ? "good-text" : bad ? "bad-text" : ""}>
        {value}
      </strong>
    </div>
  );
}

function HistoryPage({
  history,
  allHistory,
  search,
  filter,
  onSearch,
  onFilter,
  onOpen,
  onDelete,
  onClear,
  onNew,
}) {
  return (
    <div className="page">
      <PageTitle
        eyebrow="RECORDS"
        title="Inspection history"
        text="Review previously saved inspections, compliance outcomes and evidence."
        action={
          <button className="primary-button" onClick={onNew}>
            <Icon name="plus" size={18} />
            New Inspection
          </button>
        }
      />

      <div className="history-toolbar">
        <div className="search-box">
          <Icon name="search" size={20} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search inspection ID, commodity or status..."
          />
        </div>

        <div className="filter-buttons">
          {[
            "ALL",
            "COMPLIANT",
            "NON-COMPLIANT",
            "REVIEW REQUIRED",
          ].map((item) => (
            <button
              key={item}
              className={filter === item ? "active" : ""}
              onClick={() => onFilter(item)}
            >
              {item === "ALL" ? "All" : item}
            </button>
          ))}
        </div>

        {allHistory.length > 0 && (
          <button className="danger-text-button" onClick={onClear}>
            <Icon name="trash" size={16} />
            Clear
          </button>
        )}
      </div>

      <section className="panel history-panel">
        {history.length === 0 ? (
          <EmptyState
            icon="history"
            title={
              allHistory.length
                ? "No matching inspections"
                : "No inspection history"
            }
            text={
              allHistory.length
                ? "Try another search or filter."
                : "Saved inspection reports will appear here."
            }
            action={
              !allHistory.length && (
                <button className="primary-button" onClick={onNew}>
                  Start First Inspection
                </button>
              )
            }
          />
        ) : (
          <div className="history-table">
            <div className="history-head">
              <span>INSPECTION</span>
              <span>COMMODITY</span>
              <span>DATE</span>
              <span>SCORE</span>
              <span>STATUS</span>
              <span />
            </div>

            {history.map((item) => (
              <div className="history-row" key={item.id}>
                <div className="history-id">
                  <div className="table-icon">
                    <Icon name="file" size={17} />
                  </div>
                  <div>
                    <strong>{item.id}</strong>
                    <span>{item.time}</span>
                  </div>
                </div>

                <strong className="commodity-name">
                  {item.productName}
                </strong>

                <span>{item.date}</span>

                <div className="table-score">
                  <strong>{item.score}%</strong>
                  <div>
                    <span style={{ width: `${item.score}%` }} />
                  </div>
                </div>

                <StatusBadge status={item.status} />

                <div className="row-actions">
                  <button onClick={() => onOpen(item)}>
                    Open <Icon name="arrow" size={15} />
                  </button>
                  <button
                    className="delete-button"
                    onClick={() => onDelete(item.id)}
                    title="Delete inspection"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="page">
      <PageTitle
        eyebrow="SYSTEM"
        title="About MetroCheck"
        text="A decision-support prototype for packaged commodity inspection under Legal Metrology requirements."
      />

      <div className="about-hero panel">
        <div className="about-mark">
          <div className="brand-mark large-mark">
            <span>MC</span>
          </div>
        </div>

        <div>
          <span className="eyebrow">METROCHECK</span>
          <h2>From package image to inspection decision.</h2>
          <p>
            MetroCheck combines image-based text extraction, structured
            declaration analysis, rule-based compliance screening and
            inspector verification into a single inspection workflow.
          </p>
        </div>
      </div>

      <div className="about-grid">
        <AboutCard
          icon="scan"
          title="OCR & Computer Vision"
          text="Package images are processed to identify visible text and declaration patterns."
        />

        <AboutCard
          icon="shield"
          title="Rule-Based Screening"
          text="Extracted information is evaluated against configurable compliance checks."
        />

        <AboutCard
          icon="user"
          title="Inspector Verification"
          text="Automated results support the inspector instead of replacing field verification."
        />

        <AboutCard
          icon="file"
          title="Evidence & Reports"
          text="Inspection records can be saved locally and exported as structured PDF reports."
        />
      </div>

      <section className="panel legal-panel">
        <div className="panel-header">
          <div>
            <span className="panel-kicker">IMPORTANT</span>
            <h3>Prototype limitation</h3>
          </div>
        </div>

        <p>
          MetroCheck is a demonstration decision-support system. Its automated
          screening should not be treated as a legally binding determination.
          Applicable rules, exemptions, amendments, commodity-specific
          requirements and final enforcement decisions require appropriate
          inspector and legal verification.
        </p>
      </section>
    </div>
  );
}

function AboutCard({ icon, title, text }) {
  return (
    <div className="panel about-card">
      <div className="about-card-icon">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export default App;