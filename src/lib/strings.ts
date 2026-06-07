import { fixMojibake } from "./encoding";

/**
 * SINGLE SOURCE OF TRUTH for all user-facing copy.
 *
 * Every string rendered in the UI is defined here and accessed via `t`.
 * No component should contain a hardcoded user-facing string. This product
 * ships a single locale (Mongolian); the structure below is intentionally
 * locale-shaped so an additional locale can be added without touching any
 * component — by exporting a second dictionary of the same `Copy` type.
 */

export const LOCALE = "mn" as const;

const mn = {
  app: {
    name: "Уудам Трэвэл",
    tagline: "AI Туслах",
  },

  common: {
    save: "Хадгалах",
    saving: "Хадгалж байна…",
    cancel: "Болих",
    edit: "Засах",
    delete: "Устгах",
    add: "Нэмэх",
    close: "Хаах",
    refresh: "Шинэчлэх",
    retry: "Дахин оролдох",
    none: "—",
    unknown: "Тодорхойгүй",
  },

  errors: {
    boundaryTitle: "Алдаа гарлаа",
    boundaryBody:
      "Хуудсыг ачаалах үед санаандгүй алдаа гарлаа. Хуудсаа дахин ачаална уу.",
    boundaryAction: "Хуудсыг дахин ачаалах",
  },

  home: {
    metaTitle: "Уудам Трэвэл — AI Аялал Зөвлөх Туслах",
    metaDescription:
      "Уудам Трэвэлийн AI туслах: маршрут, үнэ, суудлын үлдэгдэл, аяллын мэдээллийг бодит цагийн өгөгдлөөр хариулна.",
    eyebrow: "Уудам Трэвэл",
    title: "AI Аялал Зөвлөх Туслах",
    subtitle:
      "Маршрут, үнэ, суудлын үлдэгдэл болон аяллын мэдээлэлд бодит цагийн өгөгдлөөр хариулдаг ухаалаг туслах.",
    demoTitle: "Шууд туршилт",
    demoSubtitle: "Асуултаа бичээд AI туслахын хариуг шууд аваарай.",
    adminLink: "Удирдлагын самбар",
    footerNote: "Удирдлагын самбар нь зөвхөн эрх бүхий ажилтанд зориулагдсан.",
  },

  chat: {
    emptyHint:
      "Сайн байна уу 👋 Жишээ нь: «Хөх хот аяллын үнэ ба үлдсэн суудал хэд вэ?»",
    placeholder: "Хөтөлбөр, маршрут, үнэ, суудлын талаар асуугаарай…",
    inputLabel: "Чат мессеж бичих",
    logLabel: "Чатын яриа",
    send: "Илгээх",
    sending: "Илгээж байна…",
    clear: "Цэвэрлэх",
    errorGeneric: "Хариу үүсгэх үед алдаа гарлаа. Дахин оролдоно уу.",
    errorNetwork: "Сервертэй холбогдоход алдаа гарлаа. Дахин оролдоно уу.",
    errorRateLimited:
      "Хэт олон хүсэлт илгээлээ. Хэсэг хүлээгээд дахин оролдоно уу.",
    errorTooLong: "Мессеж хэт урт байна. Богиносгоод дахин илгээнэ үү.",
  },

  admin: {
    metaTitle: "Админ удирдлагын самбар — Уудам Трэвэл",

    nav: {
      control: "Хяналт",
      settings: "Тохиргоо",
      ai: "AI өөрчлөлт",
      trips: "Аяллууд",
    },

    shell: {
      menu: "Цэс нээх",
      closeMenu: "Цэс хаах",
      refresh: "Шинэчлэх",
      openAccess: "Нээлттэй хандалт",
      restrictedAccess: "Нууцлалтай хандалт",
      dbConnected: "Өгөгдлийн сан холбогдсон",
      dbDisconnected: "Өгөгдлийн сан холбогдоогүй",
      trips: "аялал",
    },

    sections: {
      control: {
        title: "Хяналт",
        description: "Ботын идэвх, түр пауз болон сүүлийн харилцан яриаг удирдана.",
      },
      settings: {
        title: "Ботын тохиргоо",
        description:
          "Системийн заавар, хурдан хариулт, FAQ болон саналын өгөгдлийг тохируулна.",
      },
      ai: {
        title: "AI өөрчлөлтийн хүсэлт",
        description:
          "Энгийн зааврыг AI-аар санал болгуулж, баталгаажуулсны дараа хэрэгжүүлнэ.",
      },
      trips: {
        title: "Аяллын жагсаалт",
        description: "Аяллын мэдээллийг хайж, шүүж, засварлана.",
      },
    },

    boot: {
      loading: "Удирдлагын самбар ачаалж байна…",
    },

    auth: {
      title: "Админ нэвтрэлт",
      subtitle: "Үргэлжлүүлэхийн тулд админ нууц үгээ оруулна уу.",
      label: "Админ нууц үг",
      placeholder: "Нууц үг",
      submit: "Нэвтрэх",
      verifying: "Шалгаж байна…",
      failed: "Нууц үг буруу байна. Дахин оролдоно уу.",
    },

    control: {
      title: "Бот түр зогсоох удирдлага",
      description:
        "Өгөгдөл шинэчлэх үед автомат хариултыг зогсоох глобал товч.",
      botPaused: "Бот түр зогссон",
      botActive: "Бот идэвхтэй",
      lastUpdated: "Сүүлд шинэчлэгдсэн",
      reasonPlaceholder: "Түр зогсоох шалтгаан (сонголттой)",
      reasonLabel: "Түр зогсоох шалтгаан",
      pauseAll: "Бүгдийг зогсоох",
      resumeAll: "Бүгдийг сэргээх",
      pausedToast: "Бот түр зогслоо.",
      resumedToast: "Бот идэвхжлээ.",
    },

    recent: {
      title: "Сүүлийн чат ба түр пауз",
      description: "Хэрэглэгч бүр дээр түр зогсоох болон сэргээх үйлдэл.",
      empty: "Сүүлийн харилцан яриа байхгүй.",
      emptyHint: "Шинэ мессеж ирэхэд энд харагдана.",
      resume: "Сэргээх",
      pausedFor: "Түр зогссон",
      expired: "Хугацаа дууссан",
      infinite: "Хязгааргүй",
      userPausedToast: "Хэрэглэгчийн бот түр зогслоо.",
      userResumedToast: "Хэрэглэгчийн бот сэргэлээ.",
    },

    settings: {
      lastUpdated: "Сүүлд шинэчлэгдсэн",
      unsaved: "Хадгалаагүй өөрчлөлт",
      businessName: "Бизнесийн нэр",
      quickKeywords: "Хурдан мэдээлэл хайх түлхүүр үг",
      quickKeywordsHint: "Мөр тус бүрт нэг түлхүүр үг бичнэ.",
      systemPrompt: "Системийн заавар (prompt)",
      systemPromptHint: "AI-д өгөх үндсэн зан төлвийн заавар.",
      quickReply: "Хурдан мэдээллийн хариу",
      commentTriggers: "Сэтгэгдэл өдөөгч түлхүүр",
      commentTriggersHint: "Мөр тус бүрт нэг хэв маяг бичнэ.",
      commentPublic: "Сэтгэгдэлд нийтэд харагдах хариу",
      commentDm: "Сэтгэгдлийн хувийн (DM) хариу",
      tableEditorTitle: "Хүснэгтэн засварлагч",
      tableEditorHint:
        "Хүснэгт хэлбэрээр хурдан засвар хийнэ. Доорх нарийвчилсан JSON-оор мөн засварлаж болно.",
      exportHtml: "HTML-аар татах",
      faqTitle: "Түгээмэл асуулт (FAQ)",
      faqAdd: "Асуулт нэмэх",
      faqEmpty: "Асуултын мөр алга байна.",
      faqQuestion: "Асуулт",
      faqAnswer: "Хариулт",
      offersTitle: "Тусгай саналууд",
      offersAdd: "Санал нэмэх",
      offersEmpty: "Тусгай саналын мөр алга байна.",
      discountsTitle: "Хөнгөлөлтийн бодлого",
      discountsAdd: "Бодлого нэмэх",
      discountsEmpty: "Хөнгөлөлтийн мөр алга байна.",
      credentialsTitle: "Баталгаажсан баримтууд",
      credentialsAdd: "Баримт нэмэх",
      credentialsEmpty: "Баримтын мөр алга байна.",
      advancedTitle: "Нарийвчилсан JSON (туршлагатай хэрэглэгчид)",
      advancedShow: "JSON харуулах",
      advancedHide: "JSON нуух",
      jsonFaq: "Түгээмэл асуулт JSON",
      jsonOffers: "Тусгай санал JSON",
      jsonDiscounts: "Хөнгөлөлтийн бодлого JSON",
      jsonCredentials: "Баталгаажсан баримт JSON",
      save: "Тохиргоо хадгалах",
      savedToast: "Тохиргоо амжилттай хадгалагдлаа.",
      invalidJson: "Оруулсан JSON буруу форматтай байна.",
      cols: {
        name: "Нэр",
        duration: "Хугацаа",
        price: "Үнэ",
        target: "Зорилтот бүлэг",
        eligibility: "Эрхийн нөхцөл",
        description: "Тайлбар",
        discount: "Хөнгөлөлт",
        appliesTo: "Хамаарах бүлэг",
        verification: "Баталгаажуулалт",
        title: "Гарчиг",
        issuer: "Олгогч",
        issuedOn: "Огноо",
      },
      exportTitle: "Аяллын тохиргооны тайлан",
      exportOrg: "Байгууллага",
      exportAt: "Экспортолсон",
      exportEmpty: "Хоосон",
    },

    ai: {
      instructionLabel: "AI-д өгөх заавар",
      placeholder:
        "Жишээ: Xilingol travel-ийн Жинин–Линхү–Хөх хот маршрутын үлдсэн суудлыг 4 болго, хоолтой болго.",
      generate: "Санал гаргах",
      generating: "Санал боловсруулж байна…",
      apply: "Өөрчлөлт хэрэгжүүлэх",
      applying: "Хэрэгжүүлж байна…",
      confirm: "Энэ өөрчлөлтийг хэрэгжүүлэхийг баталгаажуулж байна",
      proposalTitle: "Санал болгосон өөрчлөлт",
      conflictsTitle: "Анхаарах зүйлс",
      actionsTitle: "Хийгдэх үйлдлүүд",
      noActions: "Хийгдэх үйлдэл алга байна.",
      rawJson: "Техникийн JSON харах",
      appliedToast: "AI өөрчлөлт амжилттай хэрэгжлээ.",
      emptyTitle: "Одоогоор санал алга",
      emptyBody: "Дээр заавраа бичээд «Санал гаргах» товчийг дарна уу.",
    },

    trips: {
      searchLabel: "Аялал хайх",
      searchPlaceholder: "Оператор эсвэл маршрутаар хайх…",
      statusLabel: "Төлөвөөр шүүх",
      allStatuses: "Бүх төлөв",
      empty: "Аяллын өгөгдөл олдсонгүй.",
      emptyHint: "Хайлт эсвэл шүүлтээ өөрчилж үзнэ үү.",
      count: "аялал",
      headers: {
        route: "Маршрут",
        operator: "Оператор",
        status: "Төлөв",
        seats: "Суудал",
        food: "Хоол",
        adultPrice: "Том хүний үнэ",
        childPrice: "Хүүхдийн үнэ",
        updated: "Шинэчлэгдсэн",
        actions: "Үйлдэл",
      },
      food: {
        yes: "Байгаа",
        no: "Байхгүй",
        unknown: "Тодорхойгүй",
      },
      seatsLabel: "Суудал",
      priceLabel: "Үнэ",
    },

    status: {
      active: "Идэвхтэй",
      cancelled: "Цуцлагдсан",
      sold_out: "Суудал дууссан",
      draft: "Ноорог",
    },

    editTrip: {
      title: "Аялал засах",
      save: "Аялал хадгалах",
      savedToast: "Аялал амжилттай хадгалагдлаа.",
      foodOptionUnknown: "Тодорхойгүй",
      fields: {
        category: "Ангилал",
        operator_name: "Оператор",
        route_name: "Маршрут",
        duration_text: "Хугацаа",
        adult_price: "Том хүний үнэ",
        child_price: "Хүүхдийн үнэ",
        seats_total: "Нийт суудал",
        seats_left: "Үлдсэн суудал",
        departure_dates: "Явах огноо (таслалаар тусгаарлана)",
        source_description: "Эх сурвалжийн тайлбар",
        notes: "Тэмдэглэл",
        status: "Төлөв",
        has_food: "Хоолны сонголт",
      },
    },

    feedback: {
      loadFailed: "Системийн өгөгдөл ачаалж чадсангүй.",
      actionFailed: "Үйлдлийг гүйцэтгэж чадсангүй.",
      saveSettingsFailed: "Тохиргоог хадгалж чадсангүй.",
      saveTripFailed: "Аяллыг хадгалж чадсангүй.",
      aiFailed: "AI санал үүсгэж чадсангүй.",
      applyFailed: "AI өөрчлөлтийг хэрэгжүүлж чадсангүй.",
    },
  },
} as const;

export type Copy = typeof mn;

function deepFixMojibake<T>(value: T): T {
  if (typeof value === "string") {
    return fixMojibake(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepFixMojibake(item)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, entry]) => [
      key,
      deepFixMojibake(entry),
    ]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/** The active translation dictionary. */
export const t: Copy = deepFixMojibake(mn);
