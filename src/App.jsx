import { useEffect, useMemo, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import { jsPDF } from "jspdf";
import "./App.css";

const HISTORY_KEY = "metrocheck_inspections_v7";

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

const FIELD_CONFIG = [
  ["manufacturer", "Manufacturer / Packer", "e.g. ABC Foods Pvt. Ltd."],
  ["importer", "Importer", "e.g. ABC Imports Pvt. Ltd."],
  ["countryOfOrigin", "Country of Origin", "e.g. India"],
  ["productName", "Common / Generic Name", "e.g. Basmati Rice"],
  ["netQuantity", "Net Quantity", "e.g. 1 kg"],
  ["manufactureDate", "Manufacture / Packing Date", "e.g. 08/2026"],
  ["bestBefore", "Best Before / Use By", "e.g. 12 Months"],
  ["mrp", "Maximum Retail Price", "e.g. ₹120"],
  ["consumerCare", "Consumer Care", "e.g. 1800-123-4567"],
  ["dimensions", "Dimensions", "e.g. 20 cm x 12 cm"],
  ["unitSalePrice", "Unit Sale Price", "e.g. ₹120/kg"],
];

const RULES = [
  {
    id: "manufacturer",
    title: "Manufacturer / Packer / Importer",
    short: "Responsible entity declaration",
    severity: "High",
    description:
      "The package should identify the manufacturer, packer or importer as applicable.",
    check: function (fields) {
      return Boolean(fields.manufacturer || fields.importer);
    },
  },
  {
    id: "origin",
    title: "Country of Origin",
    short: "Origin declaration",
    severity: "High",
    description:
      "Imported commodities should carry the applicable country-of-origin declaration.",
    check: function (fields) {
      return Boolean(fields.countryOfOrigin);
    },
  },
  {
    id: "generic",
    title: "Common / Generic Name",
    short: "Commodity identification",
    severity: "Medium",
    description:
      "The common or generic name of the commodity should be identifiable.",
    check: function (fields) {
      return Boolean(fields.productName);
    },
  },
  {
    id: "quantity",
    title: "Net Quantity",
    short: "Quantity declaration",
    severity: "Critical",
    description:
      "The package should declare its net quantity in an appropriate unit.",
    check: function (fields) {
      return Boolean(fields.netQuantity);
    },
  },
  {
    id: "date",
    title: "Date of Manufacture / Packing",
    short: "Manufacturing information",
    severity: "Medium",
    description:
      "Applicable manufacturing or packing date information should be declared.",
    check: function (fields) {
      return Boolean(fields.manufactureDate);
    },
  },
  {
    id: "bestBefore",
    title: "Best Before / Use By",
    short: "Validity information",
    severity: "High",
    description:
      "Where applicable, the package should declare the relevant best-before or use-by information.",
    check: function (fields) {
      return Boolean(fields.bestBefore);
    },
  },
  {
    id: "mrp",
    title: "Maximum Retail Price",
    short: "MRP inclusive of applicable taxes",
    severity: "Critical",
    description:
      "The applicable maximum retail price should be identifiable on the package.",
    check: function (fields) {
      return Boolean(fields.mrp);
    },
  },
  {
    id: "consumer",
    title: "Consumer Care Details",
    short: "Consumer contact information",
    severity: "Medium",
    description:
      "Consumer care or complaint contact information should be available where applicable.",
    check: function (fields) {
      return Boolean(fields.consumerCare);
    },
  },
  {
    id: "dimensions",
    title: "Dimensions",
    short: "Dimension declaration",
    severity: "Low",
    description:
      "Dimensions should be declared for commodities where applicable.",
    check: function (fields) {
      return Boolean(fields.dimensions);
    },
  },
  {
    id: "unitPrice",
    title: "Unit Sale Price",
    short: "Unit price declaration",
    severity: "Medium",
    description:
      "Unit sale price is checked where applicable to the package category.",
    check: function (fields) {
      return Boolean(fields.unitSalePrice);
    },
  },
];

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDate(date) {
  var value = date || new Date();

  return value.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatTime(date) {
  var value = date || new Date();

  return value.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function makeInspectionId() {
  var d = new Date();

  var stamp =
    String(d.getFullYear()).slice(-2) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");

  var random = Math.floor(1000 + Math.random() * 9000);

  return "MC-" + stamp + "-" + random;
}

function findMatch(text, patterns) {
  for (var i = 0; i < patterns.length; i += 1) {
    var match = text.match(patterns[i]);

    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return "";
}

function cleanExtractedValue(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,\-]+/, "")
    .trim();
}

function extractFields(rawText) {
  var text = normalizeText(rawText);
  var lower = text.toLowerCase();

  var fields = {
    manufacturer: cleanExtractedValue(
      findMatch(text, [
        /(?:manufactured by|manufacturer|manufactured\/packed by|packed by)\s*[:\-]?\s*([^\n]+)/i,
        /(?:mfg\.?|mfd\.?)\s*(?:by)?\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    importer: cleanExtractedValue(
      findMatch(text, [
        /(?:imported by|importer)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    countryOfOrigin: cleanExtractedValue(
      findMatch(text, [
        /(?:country of origin|origin)\s*[:\-]?\s*([^\n]+)/i,
        /(?:made in)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    productName: cleanExtractedValue(
      findMatch(text, [
        /(?:product name|common name|generic name)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    netQuantity: cleanExtractedValue(
      findMatch(text, [
        /(?:net quantity|net qty|net weight|net wt\.?)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    manufactureDate: cleanExtractedValue(
      findMatch(text, [
        /(?:date of manufacture|date of mfg|mfg\.?\s*date|packed on|packing date|date of packing|mfd)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    bestBefore: cleanExtractedValue(
      findMatch(text, [
        /(?:best before|use by|expiry|expires|exp)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    mrp: cleanExtractedValue(
      findMatch(text, [
        /(?:mrp|maximum retail price)\s*[:\-]?\s*((?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d{1,2})?)/i,
      ])
    ),

    consumerCare: cleanExtractedValue(
      findMatch(text, [
        /(?:consumer care|customer care|helpline|toll free|contact us)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    dimensions: cleanExtractedValue(
      findMatch(text, [
        /(?:dimensions|dimension|size)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),

    unitSalePrice: cleanExtractedValue(
      findMatch(text, [
        /(?:unit sale price|unit price|price per)\s*[:\-]?\s*([^\n]+)/i,
      ])
    ),
  };

  if (!fields.netQuantity) {
    var quantityMatch = text.match(
      /\b\d+(?:\.\d+)?\s?(?:kg|g|mg|ml|l|litre|liter)\b/i
    );

    if (quantityMatch) {
      fields.netQuantity = quantityMatch[0];
    }
  }

  if (!fields.mrp) {
    var mrpMatch = text.match(
      /(?:₹|rs\.?|inr)\s?[\d,]+(?:\.\d{1,2})?/i
    );

    if (mrpMatch) {
      fields.mrp = mrpMatch[0];
    }
  }

  if (!fields.countryOfOrigin && lower.includes("made in india")) {
    fields.countryOfOrigin = "India";
  }

  if (!fields.productName) {
    var lines = text
      .split("\n")
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line.length > 3;
      });

    var possibleProduct = lines.find(function (line) {
      return !/mrp|manufact|packed|import|country|quantity|best before|expiry|consumer|fssai|batch|date|licence|license/i.test(
        line
      );
    });

    if (possibleProduct) {
      fields.productName = possibleProduct;
    }
  }

  return fields;
}

function runCompliance(fields, physicalQuantity) {
  var results = RULES.map(function (rule) {
    var passed = rule.check(fields);

    return {
      id: rule.id,
      title: rule.title,
      short: rule.short,
      severity: rule.severity,
      description: rule.description,
      status: passed ? "PASS" : "FAIL",
      message: passed
        ? "Required information appears to be present in the extracted declarations."
        : "Required information could not be identified from the scanned declaration. Inspector verification is required.",
    };
  });

  if (physicalQuantity !== "" && Number(physicalQuantity) > 0) {
    var declaredNumber = parseFloat(
      String(fields.netQuantity).replace(/[^\d.]/g, "")
    );

    var measuredNumber = Number(physicalQuantity);

    if (declaredNumber > 0 && measuredNumber > 0) {
      var tolerance = declaredNumber * 0.02;
      var difference = Math.abs(measuredNumber - declaredNumber);

      var quantityRule = results.find(function (item) {
        return item.id === "quantity";
      });

      if (quantityRule) {
        if (difference <= tolerance) {
          quantityRule.status = "PASS";
          quantityRule.message =
            "Declared quantity is present and the inspector-entered measured quantity is within the demonstration tolerance.";
        } else {
          quantityRule.status = "FAIL";
          quantityRule.message =
            "Inspector-entered measured quantity differs materially from the declared quantity. Verify the measurement and applicable tolerance before making an enforcement decision.";
        }
      }
    }
  }

  return results;
}

function scoreResults(results) {
  if (!results.length) {
    return 0;
  }

  var passed = results.filter(function (item) {
    return item.status === "PASS";
  }).length;

  return Math.round((passed / results.length) * 100);
}

function overallStatus(results) {
  if (!results.length) {
    return "NOT SCANNED";
  }

  var failures = results.filter(function (item) {
    return item.status === "FAIL";
  }).length;

  if (failures === 0) {
    return "COMPLIANT";
  }

  if (failures <= 2) {
    return "REVIEW REQUIRED";
  }

  return "NON-COMPLIANT";
}

function Icon(props) {
  var name = props.name;
  var size = props.size || 20;

  var icons = {
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

function StatusBadge(props) {
  var status = props.status;
  var normalized = String(status).toLowerCase().replace(/\s/g, "-");

  return (
    <span className={"status-badge status-" + normalized}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function EmptyState(props) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={props.icon || "file"} size={28} />
      </div>

      <h3>{props.title}</h3>
      <p>{props.text}</p>

      {props.action}
    </div>
  );
}

function App() {
  var [page, setPage] = useState("dashboard");
  var [darkMode, setDarkMode] = useState(false);

  var [inspectionId, setInspectionId] = useState(makeInspectionId());
  var [imageFile, setImageFile] = useState(null);
  var [imagePreview, setImagePreview] = useState("");
  var [ocrText, setOcrText] = useState("");
  var [fields, setFields] = useState(
    Object.assign({}, EMPTY_FIELDS)
  );

  var [physicalQuantity, setPhysicalQuantity] = useState("");
  var [evidence, setEvidence] = useState([]);
  var [decision, setDecision] = useState("");
  var [notes, setNotes] = useState("");

  var [scanState, setScanState] = useState("idle");
  var [scanProgress, setScanProgress] = useState(0);
  var [toast, setToast] = useState("");

  var [history, setHistory] = useState([]);
  var [historySearch, setHistorySearch] = useState("");
  var [historyFilter, setHistoryFilter] = useState("ALL");

  var [cameraOpen, setCameraOpen] = useState(false);
  var [cameraError, setCameraError] = useState("");
  var [cameraReady, setCameraReady] = useState(false);

  var videoRef = useRef(null);
  var streamRef = useRef(null);

  useEffect(function () {
    try {
      var saved = JSON.parse(
        localStorage.getItem(HISTORY_KEY) || "[]"
      );

      if (Array.isArray(saved)) {
        setHistory(saved);
      }
    } catch (error) {
      setHistory([]);
    }
  }, []);

  useEffect(function () {
    document.body.className = darkMode ? "dark-mode" : "";
  }, [darkMode]);

  useEffect(
    function () {
      if (!toast) {
        return undefined;
      }

      var timer = setTimeout(function () {
        setToast("");
      }, 3000);

      return function () {
        clearTimeout(timer);
      };
    },
    [toast]
  );

  useEffect(function () {
    return function () {
      stopCamera();
    };
  }, []);

  var results = useMemo(
    function () {
      return runCompliance(fields, physicalQuantity);
    },
    [fields, physicalQuantity]
  );

  var score = useMemo(
    function () {
      return scoreResults(results);
    },
    [results]
  );

  var status = useMemo(
    function () {
      return overallStatus(results);
    },
    [results]
  );

  var passedCount = results.filter(function (item) {
    return item.status === "PASS";
  }).length;

  var failedCount = results.filter(function (item) {
    return item.status === "FAIL";
  }).length;

  var filteredHistory = useMemo(
    function () {
      return history.filter(function (item) {
        var search = historySearch.toLowerCase();

        var matchesSearch =
          !search ||
          (
            String(item.id || "") +
            " " +
            String(item.productName || "") +
            " " +
            String(item.status || "")
          )
            .toLowerCase()
            .includes(search);

        var matchesFilter =
          historyFilter === "ALL" ||
          item.status === historyFilter;

        return matchesSearch && matchesFilter;
      });
    },
    [history, historySearch, historyFilter]
  );

  function navigate(target) {
    setPage(target);
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function showToast(message) {
    setToast(message);
  }

  function resetInspection() {
    stopCamera();

    setInspectionId(makeInspectionId());
    setImageFile(null);
    setImagePreview("");
    setOcrText("");
    setFields(Object.assign({}, EMPTY_FIELDS));
    setPhysicalQuantity("");
    setEvidence([]);
    setDecision("");
    setNotes("");
    setScanState("idle");
    setScanProgress(0);
    setCameraOpen(false);
    setCameraError("");
    setCameraReady(false);
  }

  function startNewInspection() {
    resetInspection();
    navigate("scanner");
  }

  function handleImage(file) {
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      showToast("Please select an image file.");
      return;
    }

    if (imagePreview && imagePreview.startsWith("blob:")) {
      URL.revokeObjectURL(imagePreview);
    }

    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setScanState("ready");
    setScanProgress(0);
    setOcrText("");
    setFields(Object.assign({}, EMPTY_FIELDS));

    showToast("Product image loaded.");
  }

  async function openCamera() {
    setCameraError("");
    setCameraReady(false);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        "Camera access is not supported by this browser."
      );
      setCameraOpen(true);
      return;
    }

    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: {
            ideal: "environment",
          },
          width: {
            ideal: 1920,
          },
          height: {
            ideal: 1080,
          },
        },
        audio: false,
      });

      streamRef.current = stream;
      setCameraOpen(true);

      setTimeout(function () {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;

          videoRef.current
            .play()
            .then(function () {
              setCameraReady(true);
            })
            .catch(function () {
              setCameraReady(true);
            });
        }
      }, 100);
    } catch (error) {
      console.error(error);

      setCameraOpen(true);
      setCameraError(
        "Camera permission was denied or the camera could not be opened."
      );
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(function (track) {
        track.stop();
      });

      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraReady(false);
  }

  function closeCamera() {
    stopCamera();
    setCameraOpen(false);
    setCameraError("");
  }

  function capturePhoto() {
    var video = videoRef.current;

    if (!video || !cameraReady) {
      showToast("Camera is not ready yet.");
      return;
    }

    var width = video.videoWidth;
    var height = video.videoHeight;

    if (!width || !height) {
      showToast("Camera image is not available yet.");
      return;
    }

    var canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    var context = canvas.getContext("2d");

    context.drawImage(video, 0, 0, width, height);

    canvas.toBlob(
      function (blob) {
        if (!blob) {
          showToast("Could not capture the camera image.");
          return;
        }

        var file = new File(
          [blob],
          "MetroCheck-Capture-" + Date.now() + ".jpg",
          {
            type: "image/jpeg",
          }
        );

        if (imagePreview && imagePreview.startsWith("blob:")) {
          URL.revokeObjectURL(imagePreview);
        }

        setImageFile(file);
        setImagePreview(URL.createObjectURL(file));
        setScanState("ready");
        setScanProgress(0);
        setOcrText("");
        setFields(Object.assign({}, EMPTY_FIELDS));

        closeCamera();
        showToast("Photo captured successfully.");
      },
      "image/jpeg",
      0.92
    );
  }

  async function runOCR() {
    if (!imagePreview) {
      showToast("Capture or upload a product image first.");
      return;
    }

    setScanState("scanning");
    setScanProgress(5);
    setOcrText("");

    var worker = null;

    try {
      worker = await createWorker("eng");

      setScanProgress(25);

      var response = await worker.recognize(imagePreview);

      setScanProgress(80);

      var text = normalizeText(
        response && response.data ? response.data.text : ""
      );

      setOcrText(text);

      var extracted = extractFields(text);

      setFields(extracted);

      setScanProgress(100);
      setScanState("complete");

      showToast("OCR scan completed successfully.");
    } catch (error) {
      console.error(error);

      setScanState("error");

      showToast(
        "OCR could not process this image. You can enter fields manually."
      );
    } finally {
      if (worker) {
        try {
          await worker.terminate();
        } catch (error) {
          console.error(error);
        }
      }
    }
  }

  function updateField(key, value) {
    setFields(function (previous) {
      return Object.assign({}, previous, {
        [key]: value,
      });
    });
  }

  function handleEvidence(files) {
    var selected = Array.from(files || []);

    var list = selected.map(function (file) {
      return {
        id:
          file.name +
          "-" +
          file.lastModified +
          "-" +
          Math.random(),
        name: file.name,
        size: file.size,
        type: file.type,
      };
    });

    setEvidence(function (previous) {
      return previous.concat(list);
    });

    if (list.length) {
      showToast(
        String(list.length) + " evidence file(s) added."
      );
    }
  }

  function removeEvidence(id) {
    setEvidence(function (previous) {
      return previous.filter(function (item) {
        return item.id !== id;
      });
    });
  }

  function saveInspection() {
    var finalResults = runCompliance(
      fields,
      physicalQuantity
    );

    var finalScore = scoreResults(finalResults);

    var finalStatus =
      decision || overallStatus(finalResults);

    var record = {
      id: inspectionId,
      productName:
        fields.productName || "Unknown commodity",
      imagePreview: imagePreview,
      fields: fields,
      ocrText: ocrText,
      physicalQuantity: physicalQuantity,
      evidence: evidence,
      decision: finalStatus,
      status: finalStatus,
      score: finalScore,
      ruleResults: finalResults,
      notes: notes,
      date: formatDate(),
      time: formatTime(),
      timestamp: Date.now(),
    };

    var next = [
      record,
      ...history.filter(function (item) {
        return item.id !== inspectionId;
      }),
    ];

    setHistory(next);

    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(next)
    );

    setDecision(finalStatus);

    showToast("Inspection saved to history.");

    navigate("history");
  }

  function loadInspection(record) {
    setInspectionId(record.id);

    setImagePreview(record.imagePreview || "");

    setImageFile(null);

    setFields(
      record.fields ||
        Object.assign({}, EMPTY_FIELDS)
    );

    setOcrText(record.ocrText || "");

    setPhysicalQuantity(
      record.physicalQuantity || ""
    );

    setEvidence(record.evidence || []);

    setDecision(
      record.decision ||
        record.status ||
        ""
    );

    setNotes(record.notes || "");

    setScanState(
      record.imagePreview
        ? "complete"
        : "idle"
    );

    setScanProgress(
      record.imagePreview ? 100 : 0
    );

    navigate("scanner");
  }

  function deleteInspection(id) {
    var next = history.filter(function (item) {
      return item.id !== id;
    });

    setHistory(next);

    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(next)
    );

    showToast("Inspection removed.");
  }

  function clearHistory() {
    if (!history.length) {
      return;
    }

    var confirmed = window.confirm(
      "Delete all saved inspection history?"
    );

    if (!confirmed) {
      return;
    }

    setHistory([]);

    localStorage.removeItem(HISTORY_KEY);

    showToast("Inspection history cleared.");
  }

  function generatePDF() {
    var doc = new jsPDF();

    var margin = 16;
    var y = 18;

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

    doc.text(
      "Inspection ID: " + inspectionId,
      margin,
      y
    );

    y += 7;

    doc.text(
      "Date: " + formatDate(),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Time: " + formatTime(),
      margin,
      y
    );

    y += 12;

    doc.setFont("helvetica", "bold");
    doc.text(
      "Inspection Summary",
      margin,
      y
    );

    doc.setFont("helvetica", "normal");

    y += 8;

    doc.text(
      "Commodity: " +
        (fields.productName || "Not identified"),
      margin,
      y
    );

    y += 7;

    doc.text(
      "Compliance Score: " + score + "%",
      margin,
      y
    );

    y += 7;

    doc.text(
      "System Status: " + status,
      margin,
      y
    );

    y += 7;

    doc.text(
      "Inspector Decision: " +
        (decision || "Pending verification"),
      margin,
      y
    );

    y += 12;

    doc.setFont("helvetica", "bold");
    doc.text(
      "Declaration Analysis",
      margin,
      y
    );

    doc.setFont("helvetica", "normal");

    y += 8;

    results.forEach(function (rule, index) {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");

      doc.text(
        String(index + 1) +
          ". " +
          rule.title,
        margin,
        y
      );

      y += 6;

      doc.setFont("helvetica", "normal");

      doc.text(
        "Status: " + rule.status,
        margin + 4,
        y
      );

      y += 6;

      var lines = doc.splitTextToSize(
        rule.message,
        170
      );

      doc.text(
        lines,
        margin + 4,
        y
      );

      y += lines.length * 5 + 5;
    });

    if (physicalQuantity) {
      if (y > 260) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");

      doc.text(
        "Physical Verification",
        margin,
        y
      );

      y += 7;

      doc.setFont("helvetica", "normal");

      doc.text(
        "Inspector-entered measured quantity: " +
          physicalQuantity,
        margin,
        y
      );

      y += 10;
    }

    if (notes) {
      if (y > 250) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");

      doc.text(
        "Inspector Notes",
        margin,
        y
      );

      y += 7;

      doc.setFont("helvetica", "normal");

      var noteLines = doc.splitTextToSize(
        notes,
        175
      );

      doc.text(
        noteLines,
        margin,
        y
      );

      y += noteLines.length * 5 + 10;
    }

    if (evidence.length) {
      if (y > 250) {
        doc.addPage();
        y = 20;
      }

      doc.setFont("helvetica", "bold");

      doc.text(
        "Evidence Files",
        margin,
        y
      );

      y += 7;

      doc.setFont("helvetica", "normal");

      evidence.forEach(function (item) {
        if (y > 275) {
          doc.addPage();
          y = 20;
        }

        doc.text(
          "• " + item.name,
          margin,
          y
        );

        y += 6;
      });
    }

    if (y > 270) {
      doc.addPage();
      y = 20;
    }

    doc.setFontSize(8);
    doc.setFont("helvetica", "italic");

    doc.text(
      "MetroCheck is a prototype decision-support system. Final enforcement decisions remain subject to inspector verification and applicable law.",
      margin,
      285
    );

    doc.save(
      inspectionId +
        "-MetroCheck-Report.pdf"
    );

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
            <div className="brand-name">
              METROCHECK
            </div>

            <div className="brand-subtitle">
              LEGAL METROLOGY AI
            </div>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">
            WORKSPACE
          </div>

          <button
            className={
              "nav-item " +
              (page === "dashboard"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate("dashboard");
            }}
          >
            <Icon name="grid" />
            <span>Dashboard</span>
          </button>

          <button
            className={
              "nav-item " +
              (page === "scanner"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate("scanner");
            }}
          >
            <Icon name="scan" />
            <span>New Inspection</span>
          </button>

          <button
            className={
              "nav-item " +
              (page === "history"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate("history");
            }}
          >
            <Icon name="history" />
            <span>Inspection History</span>

            {history.length > 0 && (
              <span className="nav-count">
                {history.length}
              </span>
            )}
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">
            SYSTEM
          </div>

          <button
            className={
              "nav-item " +
              (page === "about"
                ? "active"
                : "")
            }
            onClick={function () {
              navigate("about");
            }}
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
              <strong>
                Inspection Engine
              </strong>

              <span>Operational</span>
            </div>

            <span className="online-dot" />
          </div>

          <button
            className="theme-button"
            onClick={function () {
              setDarkMode(function (previous) {
                return !previous;
              });
            }}
          >
            <Icon
              name={
                darkMode
                  ? "sun"
                  : "moon"
              }
            />

            <span>
              {darkMode
                ? "Light Mode"
                : "Dark Mode"}
            </span>
          </button>

          <div className="profile-mini">
            <div className="avatar">
              I
            </div>

            <div>
              <strong>
                Inspector
              </strong>

              <span>
                Field Operator
              </span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <div className="breadcrumb">
              <span>MetroCheck</span>

              <span className="breadcrumb-separator">
                /
              </span>

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

            <button
              className="icon-button"
              title="Settings"
            >
              <Icon
                name="settings"
                size={19}
              />
            </button>

            <div className="top-avatar">
              I
            </div>
          </div>
        </header>

        {page === "dashboard" && (
          <DashboardPage
            history={history}
            onNewInspection={
              startNewInspection
            }
            onOpenHistory={function () {
              navigate("history");
            }}
            onOpenInspection={
              loadInspection
            }
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
            physicalQuantity={
              physicalQuantity
            }
            evidence={evidence}
            decision={decision}
            notes={notes}
            cameraOpen={cameraOpen}
            cameraError={cameraError}
            cameraReady={cameraReady}
            videoRef={videoRef}
            onImage={handleImage}
            onScan={runOCR}
            onField={updateField}
            onPhysicalQuantity={
              setPhysicalQuantity
            }
            onEvidence={handleEvidence}
            onRemoveEvidence={
              removeEvidence
            }
            onDecision={setDecision}
            onNotes={setNotes}
            onSave={saveInspection}
            onPDF={generatePDF}
            onReset={resetInspection}
            onOpenCamera={openCamera}
            onCloseCamera={
              closeCamera
            }
            onCapturePhoto={
              capturePhoto
            }
          />
        )}

        {page === "history" && (
          <HistoryPage
            history={filteredHistory}
            allHistory={history}
            search={historySearch}
            filter={historyFilter}
            onSearch={
              setHistorySearch
            }
            onFilter={
              setHistoryFilter
            }
            onOpen={loadInspection}
            onDelete={
              deleteInspection
            }
            onClear={clearHistory}
            onNew={
              startNewInspection
            }
          />
        )}

        {page === "about" && (
          <AboutPage />
        )}
      </main>

      {toast && (
        <div className="toast">
          <div className="toast-icon">
            <Icon
              name="check"
              size={16}
            />
          </div>

          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

function DashboardPage(props) {
  var history = props.history;

  var compliant = history.filter(
    function (item) {
      return item.status === "COMPLIANT";
    }
  ).length;

  var nonCompliant = history.filter(
    function (item) {
      return item.status === "NON-COMPLIANT";
    }
  ).length;

  var review = history.filter(
    function (item) {
      return item.status === "REVIEW REQUIRED";
    }
  ).length;

  var recent = history.slice(0, 5);

  return (
    <div className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">
            LEGAL METROLOGY • INSPECTION WORKSPACE
          </div>

          <h1>
            Inspect smarter.
            <br />
            <span>
              Decide with evidence.
            </span>
          </h1>

          <p>
            Scan packaged commodity
            labels, identify mandatory
            declarations, analyze
            compliance requirements
            and create an
            inspection-ready report.
          </p>

          <div className="hero-actions">
            <button
              className="primary-button large"
              onClick={
                props.onNewInspection
              }
            >
              <Icon
                name="scan"
                size={21}
              />

              Start New Inspection

              <Icon
                name="arrow"
                size={19}
              />
            </button>

            <button
              className="secondary-button large"
              onClick={
                props.onOpenHistory
              }
            >
              <Icon
                name="history"
                size={19}
              />

              View History
            </button>
          </div>
        </div>

        <div className="hero-visual">
          <div className="scanner-orbit orbit-one" />
          <div className="scanner-orbit orbit-two" />

          <div className="scanner-core">
            <div className="core-line" />

            <Icon
              name="shield"
              size={38}
            />

            <strong>
              METRO
            </strong>

            <span>
              CHECK
            </span>
          </div>

          <div className="floating-chip chip-one">
            OCR
          </div>

          <div className="floating-chip chip-two">
            RULE ENGINE
          </div>

          <div className="floating-chip chip-three">
            REPORT
          </div>
        </div>
      </section>

      <section className="section-heading">
        <div>
          <span className="eyebrow">
            OVERVIEW
          </span>

          <h2>
            Inspection intelligence
          </h2>
        </div>

        <span className="section-date">
          {formatDate()}
        </span>
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
              <span className="panel-kicker">
                ACTIVITY
              </span>

              <h3>
                Recent inspections
              </h3>
            </div>

            <button
              className="text-button"
              onClick={
                props.onOpenHistory
              }
            >
              View all{" "}
              <Icon
                name="arrow"
                size={16}
              />
            </button>
          </div>

          {recent.length === 0 ? (
            <EmptyState
              icon="scan"
              title="No inspections yet"
              text="Start your first packaged commodity inspection to see activity here."
              action={
                <button
                  className="secondary-button"
                  onClick={
                    props.onNewInspection
                  }
                >
                  Start Inspection
                </button>
              }
            />
          ) : (
            <div className="activity-list">
              {recent.map(
                function (item) {
                  return (
                    <button
                      className="activity-row"
                      key={item.id}
                      onClick={
                        function () {
                          props.onOpenInspection(
                            item
                          );
                        }
                      }
                    >
                      <div className="activity-icon">
                        <Icon
                          name="scan"
                          size={18}
                        />
                      </div>

                      <div className="activity-main">
                        <strong>
                          {item.productName}
                        </strong>

                        <span>
                          {item.id} •{" "}
                          {item.date} •{" "}
                          {item.time}
                        </span>
                      </div>

                      <div className="activity-score">
                        <strong>
                          {item.score}%
                        </strong>

                        <span>
                          score
                        </span>
                      </div>

                      <StatusBadge
                        status={
                          item.status
                        }
                      />

                      <Icon
                        name="arrow"
                        size={17}
                      />
                    </button>
                  );
                }
              )}
            </div>
          )}
        </section>

        <section className="panel methodology-panel">
          <div className="panel-header">
            <div>
              <span className="panel-kicker">
                WORKFLOW
              </span>

              <h3>
                How MetroCheck works
              </h3>
            </div>
          </div>

          <div className="workflow-list">
            <WorkflowStep
              number="01"
              title="Capture"
              text="Take a live camera photo or upload a package image."
            />

            <WorkflowStep
              number="02"
              title="Extract"
              text="OCR identifies visible declarations and values."
            />

            <WorkflowStep
              number="03"
              title="Analyze"
              text="The rule engine maps extracted data to compliance checks."
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
          <Icon
            name="shield"
            size={22}
          />
        </div>

        <div>
          <strong>
            Inspector-first design
          </strong>

          <p>
            OCR and automated checks
            assist the inspector.
            Physical measurements remain
            inspector-entered and final
            enforcement decisions remain
            subject to verification.
          </p>
        </div>
      </section>
    </div>
  );
}

function StatCard(props) {
  return (
    <div
      className={
        "stat-card stat-" +
        props.tone
      }
    >
      <div className="stat-top">
        <div className="stat-icon">
          <Icon
            name={props.icon}
            size={19}
          />
        </div>

        <span>
          {props.label}
        </span>
      </div>

      <div className="stat-value">
        {props.value}
      </div>

      <div className="stat-caption">
        {props.caption}
      </div>
    </div>
  );
}

function WorkflowStep(props) {
  return (
    <div className="workflow-step">
      <div className="workflow-number">
        {props.number}
      </div>

      <div>
        <strong>
          {props.title}
        </strong>

        <p>
          {props.text}
        </p>
      </div>
    </div>
  );
}

function ScannerPage(props) {
  var [showOCR, setShowOCR] =
    useState(false);

  return (
    <div className="page scanner-page">
      <PageTitle
        eyebrow="INSPECTION WORKSPACE"
        title="New packaged commodity inspection"
        text={
          "Inspection ID " +
          props.inspectionId +
          " • Capture, analyze and verify a package."
        }
        action={
          <button
            className="secondary-button"
            onClick={
              props.onReset
            }
          >
            <Icon
              name="refresh"
              size={17}
            />

            Reset
          </button>
        }
      />

      <div className="inspection-progress">
        <ProgressStep
          number="01"
          title="Capture"
          active={
            !!props.imagePreview
          }
        />

        <div className="progress-line" />

        <ProgressStep
          number="02"
          title="OCR & Extract"
          active={
            props.scanState ===
            "complete"
          }
        />

        <div className="progress-line" />

        <ProgressStep
          number="03"
          title="Compliance"
          active={
            props.results.length > 0
          }
        />

        <div className="progress-line" />

        <ProgressStep
          number="04"
          title="Verify & Report"
          active={
            !!props.decision
          }
        />
      </div>

      <section className="scanner-layout">
        <div className="scanner-left">
          <div className="panel scanner-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  STEP 01
                </span>

                <h3>
                  Product / label image
                </h3>
              </div>

              {props.scanState ===
                "complete" && (
                <StatusBadge status="SCAN COMPLETE" />
              )}
            </div>

            {!props.imagePreview ? (
              <div>
                <label className="upload-zone">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={
                      function (event) {
                        props.onImage(
                          event.target.files &&
                            event.target.files[0]
                        );
                      }
                    }
                  />

                  <div className="upload-icon">
                    <Icon
                      name="upload"
                      size={28}
                    />
                  </div>

                  <h3>
                    Upload package image
                  </h3>

                  <p>
                    Upload a clear
                    photograph of the
                    package or label.
                  </p>

                  <span className="upload-button">
                    <Icon
                      name="upload"
                      size={17}
                    />

                    Choose Image
                  </span>

                  <small>
                    JPG, PNG or WEBP •
                    Clear text recommended
                  </small>
                </label>

                <div
                  style={{
                    display: "flex",
                    justifyContent:
                      "center",
                    marginTop: "14px",
                  }}
                >
                  <button
                    className="primary-button large"
                    type="button"
                    onClick={
                      props.onOpenCamera
                    }
                  >
                    <Icon
                      name="camera"
                      size={19}
                    />

                    Open Camera
                  </button>
                </div>
              </div>
            ) : (
              <div className="image-preview-wrap">
                <img
                  src={
                    props.imagePreview
                  }
                  alt="Uploaded packaged commodity"
                  className="product-image"
                />

                <div className="image-overlay">
                  <span>
                    {props.imageFile
                      ? props.imageFile.name
                      : "Inspection image"}
                  </span>

                  <label className="change-image">
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={
                        function (event) {
                          props.onImage(
                            event.target.files &&
                              event.target.files[0]
                          );
                        }
                      }
                    />

                    Change image
                  </label>
                </div>
              </div>
            )}

            {props.imagePreview && (
              <div className="scan-action-row">
                <div className="file-meta">
                  <div className="file-meta-icon">
                    <Icon
                      name="file"
                      size={18}
                    />
                  </div>

                  <div>
                    <strong>
                      {props.imageFile
                        ? props.imageFile.name
                        : "Package image"}
                    </strong>

                    <span>
                      {props.imageFile &&
                      props.imageFile.size
                        ? (
                            props.imageFile
                              .size /
                            1024 /
                            1024
                          ).toFixed(2) +
                          " MB"
                        : "Loaded inspection image"}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    flexWrap:
                      "wrap",
                    justifyContent:
                      "flex-end",
                  }}
                >
                  <button
                    className="secondary-button"
                    onClick={
                      props.onOpenCamera
                    }
                  >
                    <Icon
                      name="camera"
                      size={18}
                    />

                    Camera
                  </button>

                  <button
                    className="primary-button"
                    onClick={
                      props.onScan
                    }
                    disabled={
                      props.scanState ===
                      "scanning"
                    }
                  >
                    <Icon
                      name={
                        props.scanState ===
                        "scanning"
                          ? "refresh"
                          : "scan"
                      }
                      size={18}
                    />

                    {props.scanState ===
                    "scanning"
                      ? "Scanning..."
                      : props.scanState ===
                        "complete"
                      ? "Scan Again"
                      : "Run OCR Scan"}
                  </button>
                </div>
              </div>
            )}

            {props.scanState ===
              "scanning" && (
              <div className="scan-progress-box">
                <div className="scan-progress-top">
                  <span>
                    Analyzing package image
                  </span>

                  <strong>
                    {props.scanProgress}%
                  </strong>
                </div>

                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width:
                        String(
                          props.scanProgress
                        ) + "%",
                    }}
                  />
                </div>

                <span>
                  OCR is identifying
                  text and declaration
                  patterns. This may take
                  a few moments.
                </span>
              </div>
            )}

            {props.scanState ===
              "error" && (
              <div className="error-box">
                <div className="error-icon">
                  <Icon
                    name="warning"
                    size={18}
                  />
                </div>

                <div>
                  <strong>
                    OCR processing failed
                  </strong>

                  <p>
                    You can continue by
                    entering the declaration
                    fields manually.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  STEP 02
                </span>

                <h3>
                  Extracted declarations
                </h3>
              </div>

              <button
                className="text-button"
                onClick={function () {
                  setShowOCR(
                    function (previous) {
                      return !previous;
                    }
                  );
                }}
              >
                {showOCR
                  ? "Hide OCR text"
                  : "View raw OCR"}
              </button>
            </div>

            {showOCR && (
              <div className="ocr-box">
                {props.ocrText ||
                  "No OCR text available yet."}
              </div>
            )}

            <div className="field-grid">
              {FIELD_CONFIG.map(
                function (item) {
                  var key = item[0];
                  var label = item[1];
                  var placeholder =
                    item[2];

                  return (
                    <div
                      className="field"
                      key={key}
                    >
                      <label>
                        {label}
                      </label>

                      <input
                        value={
                          props.fields[
                            key
                          ]
                        }
                        onChange={
                          function (
                            event
                          ) {
                            props.onField(
                              key,
                              event.target.value
                            );
                          }
                        }
                        placeholder={
                          placeholder
                        }
                      />
                    </div>
                  );
                }
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  STEP 03
                </span>

                <h3>
                  Compliance analysis
                </h3>
              </div>

              {props.results
                .length > 0 && (
                <StatusBadge
                  status={
                    props.status
                  }
                />
              )}
            </div>

            {props.results.length ===
            0 ? (
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
                      <strong>
                        {props.score}
                      </strong>

                      <span>
                        %
                      </span>
                    </div>
                  </div>

                  <div className="compliance-summary-copy">
                    <span className="panel-kicker">
                      AUTOMATED SCREENING
                    </span>

                    <h3>
                      {props.status}
                    </h3>

                    <p>
                      {props.passedCount}{" "}
                      checks passed and{" "}
                      {props.failedCount}{" "}
                      checks require
                      attention.
                    </p>
                  </div>

                  <div className="mini-stat">
                    <strong>
                      {props.passedCount}
                    </strong>

                    <span>
                      Passed
                    </span>
                  </div>

                  <div className="mini-stat danger">
                    <strong>
                      {props.failedCount}
                    </strong>

                    <span>
                      Failed
                    </span>
                  </div>
                </div>

                <div className="rule-list">
                  {props.results.map(
                    function (rule) {
                      return (
                        <RuleCard
                          rule={rule}
                          key={
                            rule.id
                          }
                        />
                      );
                    }
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="scanner-right">
          <div className="panel sticky-panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  LIVE RESULT
                </span>

                <h3>
                  Inspection status
                </h3>
              </div>
            </div>

            <div
              className={
                "result-hero result-" +
                props.status
                  .toLowerCase()
                  .replaceAll(
                    " ",
                    "-"
                  )
              }
            >
              <div className="result-icon">
                <Icon
                  name={
                    props.status ===
                    "COMPLIANT"
                      ? "check"
                      : props.status ===
                        "NON-COMPLIANT"
                      ? "warning"
                      : "search"
                  }
                  size={25}
                />
              </div>

              <div>
                <span>
                  Current assessment
                </span>

                <strong>
                  {props.status}
                </strong>
              </div>
            </div>

            <div className="result-score-row">
              <div>
                <span>
                  Compliance score
                </span>

                <strong>
                  {props.score}%
                </strong>
              </div>

              <div className="score-bar">
                <div
                  style={{
                    width:
                      String(
                        props.score
                      ) + "%",
                  }}
                  className="score-bar-fill"
                />
              </div>
            </div>

            <div className="summary-list">
              <SummaryLine
                label="Rules evaluated"
                value={
                  props.results
                    .length
                }
              />

              <SummaryLine
                label="Passed"
                value={
                  props.passedCount
                }
                good
              />

              <SummaryLine
                label="Attention required"
                value={
                  props.failedCount
                }
                bad
              />

              <SummaryLine
                label="Evidence files"
                value={
                  props.evidence
                    .length
                }
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  PHYSICAL CHECK
                </span>

                <h3>
                  Inspector verification
                </h3>
              </div>
            </div>

            <div className="inspector-note">
              <Icon
                name="info"
                size={18}
              />

              <span>
                Physical quantity must
                be entered by the
                inspector. It is not
                estimated from the image.
              </span>
            </div>

            <div className="field">
              <label>
                Measured quantity
              </label>

              <div className="input-with-suffix">
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={
                    props.physicalQuantity
                  }
                  onChange={
                    function (
                      event
                    ) {
                      props.onPhysicalQuantity(
                        event.target.value
                      );
                    }
                  }
                  placeholder="Enter measured quantity"
                />

                <span>
                  actual
                </span>
              </div>
            </div>

            <div className="decision-block">
              <label>
                Inspector decision
              </label>

              <div className="decision-options">
                {[
                  [
                    "COMPLIANT",
                    "check",
                  ],
                  [
                    "NON-COMPLIANT",
                    "warning",
                  ],
                  [
                    "REVIEW REQUIRED",
                    "search",
                  ],
                ].map(
                  function (item) {
                    return (
                      <button
                        key={
                          item[0]
                        }
                        className={
                          "decision-option " +
                          (props.decision ===
                          item[0]
                            ? "selected"
                            : "")
                        }
                        onClick={
                          function () {
                            props.onDecision(
                              item[0]
                            );
                          }
                        }
                      >
                        <Icon
                          name={
                            item[1]
                          }
                          size={16}
                        />

                        {item[0]}
                      </button>
                    );
                  }
                )}
              </div>
            </div>

            <div className="field">
              <label>
                Inspector notes
              </label>

              <textarea
                value={
                  props.notes
                }
                onChange={
                  function (
                    event
                  ) {
                    props.onNotes(
                      event.target.value
                    );
                  }
                }
                placeholder="Record observations, verification notes or additional findings..."
                rows={5}
              />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <span className="panel-kicker">
                  EVIDENCE
                </span>

                <h3>
                  Supporting files
                </h3>
              </div>
            </div>

            <label className="evidence-upload">
              <input
                type="file"
                multiple
                accept="image/*,.pdf"
                onChange={
                  function (event) {
                    props.onEvidence(
                      event.target.files
                    );
                  }
                }
              />

              <Icon
                name="upload"
                size={20}
              />

              <span>
                <strong>
                  Add evidence
                </strong>

                <small>
                  Photos or PDF documents
                </small>
              </span>
            </label>

            {props.evidence
              .length > 0 && (
              <div className="evidence-list">
                {props.evidence.map(
                  function (item) {
                    return (
                      <div
                        className="evidence-item"
                        key={
                          item.id
                        }
                      >
                        <div className="evidence-file-icon">
                          <Icon
                            name="file"
                            size={16}
                          />
                        </div>

                        <div>
                          <strong>
                            {item.name}
                          </strong>

                          <span>
                            {(
                              item.size /
                              1024
                            ).toFixed(
                              0
                            )}{" "}
                            KB
                          </span>
                        </div>

                        <button
                          onClick={
                            function () {
                              props.onRemoveEvidence(
                                item.id
                              );
                            }
                          }
                        >
                          <Icon
                            name="close"
                            size={16}
                          />
                        </button>
                      </div>
                    );
                  }
                )}
              </div>
            )}
          </div>

          <div className="final-actions">
            <button
              className="secondary-button"
              onClick={
                props.onPDF
              }
            >
              <Icon
                name="download"
                size={18}
              />

              Generate PDF
            </button>

            <button
              className="primary-button large"
              onClick={
                props.onSave
              }
            >
              <Icon
                name="check"
                size={18}
              />

              Save Inspection

              <Icon
                name="arrow"
                size={18}
              />
            </button>
          </div>
        </div>
      </section>

      {props.cameraOpen && (
        <CameraModal
          videoRef={
            props.videoRef
          }
          cameraError={
            props.cameraError
          }
          cameraReady={
            props.cameraReady
          }
          onClose={
            props.onCloseCamera
          }
          onCapture={
            props.onCapturePhoto
          }
        />
      )}
    </div>
  );
}

function CameraModal(props) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background:
          "rgba(4, 12, 28, 0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        style={{
          width: "min(900px, 100%)",
          maxHeight: "92vh",
          overflow: "auto",
          background:
            "var(--surface, #ffffff)",
          borderRadius: "22px",
          padding: "20px",
          boxShadow:
            "0 25px 80px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent:
              "space-between",
            alignItems: "center",
            marginBottom: "16px",
            gap: "12px",
          }}
        >
          <div>
            <span className="panel-kicker">
              LIVE CAMERA
            </span>

            <h2
              style={{
                margin:
                  "4px 0 0",
              }}
            >
              Capture package image
            </h2>
          </div>

          <button
            className="icon-button"
            onClick={
              props.onClose
            }
            title="Close camera"
          >
            <Icon
              name="close"
              size={22}
            />
          </button>
        </div>

        {props.cameraError ? (
          <div
            className="error-box"
            style={{
              marginBottom:
                "16px",
            }}
          >
            <div className="error-icon">
              <Icon
                name="warning"
                size={18}
              />
            </div>

            <div>
              <strong>
                Camera unavailable
              </strong>

              <p>
                {props.cameraError}
              </p>
            </div>
          </div>
        ) : (
          <div
            style={{
              position:
                "relative",
              background:
                "#050b14",
              borderRadius:
                "18px",
              overflow:
                "hidden",
              minHeight:
                "360px",
              display: "flex",
              alignItems:
                "center",
              justifyContent:
                "center",
            }}
          >
            <video
              ref={
                props.videoRef
              }
              autoPlay
              playsInline
              muted
              style={{
                display: "block",
                width: "100%",
                maxHeight:
                  "65vh",
                objectFit:
                  "contain",
              }}
            />

            <div
              style={{
                position:
                  "absolute",
                inset:
                  "12%",
                border:
                  "2px solid rgba(255,255,255,0.8)",
                borderRadius:
                  "12px",
                pointerEvents:
                  "none",
              }}
            />

            <div
              style={{
                position:
                  "absolute",
                left: 0,
                right: 0,
                bottom:
                  "20px",
                textAlign:
                  "center",
                color:
                  "white",
                fontSize:
                  "13px",
                textShadow:
                  "0 2px 8px rgba(0,0,0,0.8)",
              }}
            >
              Align the package or
              label inside the frame
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent:
              "center",
            gap: "12px",
            marginTop: "18px",
            flexWrap:
              "wrap",
          }}
        >
          <button
            className="secondary-button"
            onClick={
              props.onClose
            }
          >
            <Icon
              name="close"
              size={18}
            />

            Cancel
          </button>

          <button
            className="primary-button large"
            disabled={
              !props.cameraReady ||
              !!props.cameraError
            }
            onClick={
              props.onCapture
            }
          >
            <Icon
              name="camera"
              size={20}
            />

            Capture Photo
          </button>
        </div>
      </div>
    </div>
  );
}

function PageTitle(props) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">
          {props.eyebrow}
        </span>

        <h1>
          {props.title}
        </h1>

        <p>
          {props.text}
        </p>
      </div>

      {props.action}
    </div>
  );
}

function ProgressStep(props) {
  return (
    <div
      className={
        "progress-step " +
        (props.active
          ? "active"
          : "")
      }
    >
      <span>
        {props.number}
      </span>

      <strong>
        {props.title}
      </strong>
    </div>
  );
}

function RuleCard(props) {
  var rule = props.rule;

  return (
    <div
      className={
        "rule-card rule-" +
        rule.status.toLowerCase()
      }
    >
      <div className="rule-status-icon">
        <Icon
          name={
            rule.status ===
            "PASS"
              ? "check"
              : "warning"
          }
          size={17}
        />
      </div>

      <div className="rule-content">
        <div className="rule-title-row">
          <div>
            <strong>
              {rule.title}
            </strong>

            <span>
              {rule.short}
            </span>
          </div>

          <div className="rule-right">
            <span
              className={
                "severity severity-" +
                rule.severity.toLowerCase()
              }
            >
              {rule.severity}
            </span>

            <StatusBadge
              status={
                rule.status
              }
            />
          </div>
        </div>

        <p>
          {rule.message}
        </p>

        {rule.status ===
          "FAIL" && (
          <small
            style={{
              display:
                "block",
              marginTop:
                "6px",
              opacity:
                0.75,
            }}
          >
            Rule support:
            {" "}
            {rule.description}
          </small>
        )}
      </div>
    </div>
  );
}

function SummaryLine(props) {
  return (
    <div className="summary-line">
      <span>
        {props.label}
      </span>

      <strong
        className={
          props.good
            ? "good-text"
            : props.bad
            ? "bad-text"
            : ""
        }
      >
        {props.value}
      </strong>
    </div>
  );
}

function HistoryPage(props) {
  return (
    <div className="page">
      <PageTitle
        eyebrow="RECORDS"
        title="Inspection history"
        text="Review previously saved inspections, compliance outcomes and evidence."
        action={
          <button
            className="primary-button"
            onClick={
              props.onNew
            }
          >
            <Icon
              name="plus"
              size={18}
            />

            New Inspection
          </button>
        }
      />

      <div className="history-toolbar">
        <div className="search-box">
          <Icon
            name="search"
            size={20}
          />

          <input
            value={
              props.search
            }
            onChange={
              function (
                event
              ) {
                props.onSearch(
                  event.target.value
                );
              }
            }
            placeholder="Search inspection ID, commodity or status..."
          />
        </div>

        <div className="filter-buttons">
          {[
            "ALL",
            "COMPLIANT",
            "NON-COMPLIANT",
            "REVIEW REQUIRED",
          ].map(
            function (item) {
              return (
                <button
                  key={item}
                  className={
                    props.filter ===
                    item
                      ? "active"
                      : ""
                  }
                  onClick={
                    function () {
                      props.onFilter(
                        item
                      );
                    }
                  }
                >
                  {item ===
                  "ALL"
                    ? "All"
                    : item}
                </button>
              );
            }
          )}
        </div>

        {props.allHistory
          .length > 0 && (
          <button
            className="danger-text-button"
            onClick={
              props.onClear
            }
          >
            <Icon
              name="trash"
              size={16}
            />

            Clear
          </button>
        )}
      </div>

      <section className="panel history-panel">
        {props.history.length ===
        0 ? (
          <EmptyState
            icon="history"
            title={
              props.allHistory
                .length
                ? "No matching inspections"
                : "No inspection history"
            }
            text={
              props.allHistory
                .length
                ? "Try another search or filter."
                : "Saved inspection reports will appear here."
            }
            action={
              !props.allHistory
                .length && (
                <button
                  className="primary-button"
                  onClick={
                    props.onNew
                  }
                >
                  Start First
                  Inspection
                </button>
              )
            }
          />
        ) : (
          <div className="history-table">
            <div className="history-head">
              <span>
                INSPECTION
              </span>

              <span>
                COMMODITY
              </span>

              <span>
                DATE
              </span>

              <span>
                SCORE
              </span>

              <span>
                STATUS
              </span>

              <span />
            </div>

            {props.history.map(
              function (item) {
                return (
                  <div
                    className="history-row"
                    key={item.id}
                  >
                    <div className="history-id">
                      <div className="table-icon">
                        <Icon
                          name="file"
                          size={17}
                        />
                      </div>

                      <div>
                        <strong>
                          {item.id}
                        </strong>

                        <span>
                          {item.time}
                        </span>
                      </div>
                    </div>

                    <strong className="commodity-name">
                      {item.productName}
                    </strong>

                    <span>
                      {item.date}
                    </span>

                    <div className="table-score">
                      <strong>
                        {item.score}%
                      </strong>

                      <div>
                        <span
                          style={{
                            width:
                              String(
                                item.score
                              ) +
                              "%",
                          }}
                        />
                      </div>
                    </div>

                    <StatusBadge
                      status={
                        item.status
                      }
                    />

                    <div className="row-actions">
                      <button
                        onClick={
                          function () {
                            props.onOpen(
                              item
                            );
                          }
                        }
                      >
                        Open{" "}
                        <Icon
                          name="arrow"
                          size={15}
                        />
                      </button>

                      <button
                        className="delete-button"
                        onClick={
                          function () {
                            props.onDelete(
                              item.id
                            );
                          }
                        }
                        title="Delete inspection"
                      >
                        <Icon
                          name="trash"
                          size={15}
                        />
                      </button>
                    </div>
                  </div>
                );
              }
            )}
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
            <span>
              MC
            </span>
          </div>
        </div>

        <div>
          <span className="eyebrow">
            METROCHECK
          </span>

          <h2>
            From package image
            to inspection
            decision.
          </h2>

          <p>
            MetroCheck combines
            camera capture,
            image-based text
            extraction, structured
            declaration analysis,
            rule-based compliance
            screening and inspector
            verification into a
            single inspection
            workflow.
          </p>
        </div>
      </div>

      <div className="about-grid">
        <AboutCard
          icon="camera"
          title="Camera Capture"
          text="Inspectors can capture a package or label directly from the browser camera."
        />

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
            <span className="panel-kicker">
              IMPORTANT
            </span>

            <h3>
              Prototype limitation
            </h3>
          </div>
        </div>

        <p>
          MetroCheck is a demonstration
          decision-support system.
          Automated screening should
          not be treated as a legally
          binding determination.
          Applicable rules, exemptions,
          amendments, commodity-specific
          requirements and final
          enforcement decisions require
          appropriate inspector and
          legal verification.
        </p>
      </section>
    </div>
  );
}

function AboutCard(props) {
  return (
    <div className="panel about-card">
      <div className="about-card-icon">
        <Icon
          name={props.icon}
          size={22}
        />
      </div>

      <h3>
        {props.title}
      </h3>

      <p>
        {props.text}
      </p>
    </div>
  );
}

export default App;