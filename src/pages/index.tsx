import DemoChat from "@/components/DemoChat";
import { Badge, Card, Icons } from "@/components/ui";
import Head from "next/head";
import Link from "next/link";

const FEATURE_ITEMS = [
  {
    title: "Бодит өгөгдөл",
    body: "Үнэ, суудал, гарах өдөр зэрэг мэдээллийг туршилтын чатаар хурдан шалгана.",
  },
  {
    title: "Монгол хэлний хариулт",
    body: "Хэрэглэгчийн асуултад монгол хэлээр товч, ойлгомжтой байдлаар хариулна.",
  },
  {
    title: "Админ хяналт",
    body: "Аялал шинэчлэх, AI санал шалгах, ботын төлөвийг удирдах боломжтой.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas px-4 py-6 md:px-8 md:py-8">
      <Head>
        <title>Уудам Трэвел AI Туслах</title>
        <meta
          name="description"
          content="Уудам Трэвелийн AI туслах: маршрут, үнэ, гарах өдөр, суудлын үлдэгдэл болон аяллын мэдээлэлд хурдан хариулна."
        />
      </Head>

      <main className="mx-auto max-w-6xl space-y-6">
        <Card className="overflow-hidden">
          <div className="bg-linear-to-br from-brand to-brand-hover px-6 py-8 text-white md:px-8 md:py-10">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
              <div className="max-w-3xl">
                <Badge tone="neutral" className="bg-white/12 text-white">
                  Уудам Трэвел
                </Badge>
                <h1 className="mt-5 text-3xl font-semibold tracking-tight md:text-4xl">
                  Аяллын мэдээлэлд шууд, ойлгомжтой хариулах AI туслах
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  Маршрут, үнэ, гарах өдөр, суудлын үлдэгдэл болон аяллын гол
                  мэдээллийг бодит өгөгдөл дээр тулгуурлан хурдан шалгах
                  туршилтын орчин.
                </p>

                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href="#demo-chat"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/20 bg-white px-5 text-sm font-semibold text-brand transition-colors hover:bg-white/92"
                  >
                    <Icons.play size={16} />
                    Шууд турших
                  </Link>
                  <Link
                    href="/admin"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-white/18 bg-white/10 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/16"
                  >
                    <Icons.settings size={16} />
                    Удирдлагын самбар
                  </Link>
                </div>
              </div>

              <div className="rounded-[24px] border border-white/14 bg-white/8 p-5 shadow-lg backdrop-blur-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/65">
                      Live Preview
                    </p>
                    <p className="mt-1 text-sm font-medium text-white/90">
                      Хэрэглэгчид очих хариуны өнгө, хэмнэл, агуулгыг шууд харуулна.
                    </p>
                  </div>
                  <span className="rounded-full bg-emerald-400/18 px-2.5 py-1 text-xs font-semibold text-emerald-100">
                    AI ready
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="max-w-[88%] rounded-[18px] rounded-bl-md bg-white px-4 py-3 text-sm font-medium text-ink shadow-sm">
                    Хөх хот чиглэлийн сүүлийн үнэ хэд вэ?
                  </div>
                  <div className="ml-auto rounded-[18px] rounded-br-md border border-white/14 bg-white/10 px-4 py-3 text-sm leading-6 text-white/90">
                    Одоогийн өгөгдлөөр оператороос хамаараад үнэ өөр байж болно.
                    Гарах өдөр болон суудлын мэдээлэлтэй нь хамт шалгаж хариулна.
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs text-white/75">
                    Маршрут
                  </span>
                  <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs text-white/75">
                    Үнэ
                  </span>
                  <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs text-white/75">
                    Суудал
                  </span>
                  <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs text-white/75">
                    Гарах өдөр
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 border-t border-line bg-surface px-6 py-5 md:grid-cols-3 md:px-8">
            {FEATURE_ITEMS.map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-line bg-canvas/65 p-4"
              >
                <p className="text-sm font-semibold text-ink">{item.title}</p>
                <p className="mt-1 text-sm leading-6 text-ink-muted">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card id="demo-chat" className="p-6 md:p-8">
          <div className="max-w-2xl">
            <Badge tone="brand">Шууд демо</Badge>
            <h2 className="mt-3 text-2xl font-semibold text-ink">
              Хариултын чанарыг шууд шалга
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              Хэрэглэгч яг юу асуух байсан тэр хэлбэрээр бичээд бот ямар хариу
              өгөхийг бодитоор туршаарай.
            </p>
          </div>
          <div className="mt-5">
            <DemoChat />
          </div>
        </Card>
      </main>
    </div>
  );
}
