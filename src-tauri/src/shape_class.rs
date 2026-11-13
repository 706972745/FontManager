//! 按**字形几何**判分类：不看名字、不看 OS/2 / PANOSE。
//!
//! 为什么要有这一层（用户 2026-11-13 提的硬要求）：关键词表只对「命名习惯已知」
//! 的字体有效。字体库年年进新字，新字体名字里没有任何可匹配的词，就全掉进兜底的
//! 「展示」—— 那不是分类，是垃圾桶。字形是唯一对**任何**字体都成立的信号。
//!
//! 三个特征（都能从 `ttf_parser::Face::outline_glyph` 的轮廓算出来）：
//!
//! 1. **拉丁衬线比**：`I` 与 `l`（都缺时用 `H`）在上下衬线带处的墨宽 ÷ 中间墨宽。
//!    衬线体上下有横杠，比值 ≥ 2；无衬线是一根等宽的竖，比值 ≈ 1。
//!    **必须两个字形一起作证**：Verdana / Tahoma 的大写 `I` 天生带横杠（比值 ≈ 3），
//!    只看 `I` 会把这两个无衬线体判成衬线。
//! 2. **拉丁笔画对比度**：`o` / `O` 左右竖画平均厚 ÷ 上下横画平均厚。实测衬线 2.1–4.0、
//!    无衬线 1.0–1.37，中间是空的。只在特征 1 判不出时用。
//! 3. **中文宋 / 黑**：`一` 两端与中段的厚度比（宋体两端有顿角，≥ 1.5）+ `十`
//!    竖画 / 横画厚度比（宋体横细竖粗，≥ 1.6）。**两个信号都一致才下结论**。
//!
//! 楷体 / 行书这类不在这层区分 —— 它们的笔画也有粗细变化，和宋体撞车；手写只靠
//! 名字 + PANOSE，判不出就走兜底展示（用户口径：宁可偏差，不要消失）。
//!
//! 稳健性：
//! - 缺字形的字体（图标字体、纯汉字字体、纯西文字体）任一步取不到就跳过该特征，
//!   不 panic、不返回错值；三个特征都给不出结论就返回 `None`。
//! - 复合字形（composite）由 `outline_glyph` 自己展开，这里不碰 `glyf`。
//! - 变量字体按默认实例取（`outline_glyph` 默认不应用 `var_coords`）。
//! - 每个字体最多解析 4 个字形、`一` 最多 40 次竖向扫描，没有 O(点数²) 的运算
//!   （单字形实测在 0.1 ms 量级，全库 5853 字面的增量在秒级以内）。

use crate::font_types::Classification;

/// 轮廓扁平化后的点集：每条 contour 是一串闭合折线点（首尾不重复存）。
type Contours = Vec<Vec<(f32, f32)>>;

/// 二次曲线细分数（够把衬线的圆角还原出来，又不至于让点数爆炸）。
const QUAD_STEPS: usize = 8;
/// 三次曲线细分数。
const CURVE_STEPS: usize = 10;
/// `一` 的横向采样点个数。
const HAN_SCAN: usize = 40;
/// 取「两端」厚度时每侧用的采样点个数。
const HAN_END_POINTS: usize = 3;

/// 衬线比：≥ 这个值判衬线。
///
/// 定标实测（系统字体，`I` 的衬线带 / 竖干）：Times 3.03、Georgia 3.00、
/// Cambria 2.24、Arial 1.00、Segoe UI 1.00 —— 阈值 2.0 离两边都远。
const SERIF_RATIO_HI: f32 = 2.0;
/// 衬线比：≤ 这个值判无衬线。
const SERIF_RATIO_LO: f32 = 1.35;
/// 量「衬线有多宽」时，从顶端 / 底端往里取的几条线（占字高的比例）。
const SERIF_BAND_FRACS: [f32; 4] = [0.008, 0.015, 0.022, 0.030];
/// 笔画对比度：≥ 这个值判衬线。
///
/// 定标实测（`o` 的竖画 / 横画）：衬线一批全在 2.1–4.0（Times 2.68、Georgia 2.73、
/// Cambria 2.40、Palatino 2.77、Garamond 3.98），无衬线一批全在 1.0–1.37
/// （Arial 1.25、Verdana 1.20、Segoe UI 1.22、Candara 1.37）。
/// 两堆之间是空的，所以阈值取在缝里，中间带一律不下结论。
const CONTRAST_HI: f32 = 1.9;
/// 笔画对比度：≤ 这个值判无衬线。
const CONTRAST_LO: f32 = 1.55;
/// `一` 两端 / 中段厚度比：≥ 这个值算「宋体的顿角」。
const HAN_END_HI: f32 = 1.5;
/// `一` 两端 / 中段厚度比：≤ 这个值算「等厚」。
const HAN_END_LO: f32 = 1.25;
/// `十` 竖 / 横厚度比：≥ 这个值算「横细竖粗」。
///
/// 定标实测：宋体 simsun 2.50 / 黑体 simhei 1.22 / 微软雅黑 1.14 / 楷体 1.34。
/// 所以「横细竖粗」的线拉到 1.6（离黑体那批 1.1–1.25 很远），
/// 「等厚」的线只到 1.30（楷体 1.34 就该判不出，不能算黑体）。
const HAN_STROKE_HI: f32 = 1.6;
/// `十` 竖 / 横厚度比：≤ 这个值算「等厚」。
const HAN_STROKE_LO: f32 = 1.30;

/// 一个字体能算出来的全部几何指标（诊断 / 定标用；`None` = 该特征取不到）。
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ShapeMetrics {
    /// 大写 `I`：上下衬线带墨宽 ÷ 中间墨宽。无衬线 ≈ 1，衬线 ≥ 2。
    pub serif_ratio_i: Option<f32>,
    /// 小写 `l`：同上。**必须和 `I` 一起看** —— Verdana / Tahoma 的大写 `I` 天生带
    /// 上下横杠（设计上为了跟 `l` 区分），单看 `I` 会把它们判成衬线。
    pub serif_ratio_l: Option<f32>,
    /// `o` / `O`：竖画平均厚 ÷ 横画平均厚。无衬线 ≈ 1，衬线 ≥ 1.35。
    pub stroke_contrast: Option<f32>,
    /// `一`：两端 / 中段厚度比。黑体 ≈ 1，宋体 ≥ 1.5。
    pub han_end_ratio: Option<f32>,
    /// `十`：竖画厚 ÷ 横画厚。黑体 ≈ 1，宋体 ≥ 1.6。
    pub han_stroke_ratio: Option<f32>,
}

/// `classify_by_shape` 的详细版：先把所有指标都算出来，再统一判定。
///
/// 拆成两步是为了让诊断工具能打印真实数值（阈值站不站得住，只能靠这些数说话）。
pub(crate) fn shape_metrics(face: &ttf_parser::Face) -> ShapeMetrics {
    ShapeMetrics {
        serif_ratio_i: serif_ratio_of(face, 'I'),
        serif_ratio_l: serif_ratio_of(face, 'l'),
        stroke_contrast: latin_stroke_contrast(face),
        han_end_ratio: contours_of(face, '一').and_then(|c| han_end_ratio(&c)),
        han_stroke_ratio: contours_of(face, '十').and_then(|c| han_stroke_ratio(&c)),
    }
}

/// 只看字形几何判分类；判不出返回 `None`（调用方负责兜底成展示）。
pub(crate) fn classify_by_shape(face: &ttf_parser::Face) -> Option<Classification> {
    let m = shape_metrics(face);
    // 有汉字就只按中文的两条特征判，**不再退回拉丁特征**：中日韩字体的拉丁半角字身
    // 一律等宽、而且大多被画成「半角无衬线」，拿它判会把宋体判成无衬线。
    // 中文两条特征判不出（楷体、美术字、立体字）就返回 `None` → 兜底展示。
    if m.han_end_ratio.is_some() || m.han_stroke_ratio.is_some() {
        return han_verdict(&m);
    }
    latin_verdict(&m)
}

/// 中文：宋（横细竖粗 + 两头顿角）vs 黑（笔画等厚）。两个信号都一致才下结论。
fn han_verdict(m: &ShapeMetrics) -> Option<Classification> {
    let (end, stroke) = (m.han_end_ratio?, m.han_stroke_ratio?);
    let serif = end >= HAN_END_HI && stroke >= HAN_STROKE_HI;
    let sans = end <= HAN_END_LO && stroke <= HAN_STROKE_LO;
    if serif {
        Some(Classification::Serif)
    } else if sans {
        Some(Classification::Sans)
    } else {
        None
    }
}

/// 西文：先用衬线比（最可靠），判不出再用笔画对比度。
///
/// **门槛**（装饰 / 像素 / 图案字体不许被硬塞进衬线或无衬线）：
/// - `o` 必须是一个正常的闭合环（过中心的两个方向都恰好各两段墨）。像素字、3D 字、
///   把字母画成图案的字体这一关就过不去，直接返回 `None`，最后落回兜底展示 ——
///   那才是它们该待的地方。
/// - 衬线比必须**由 `I` 和 `l` 两个字形共同作证**：两个都给出结论且一致才采信；
///   只有一个给得出就采信那一个；两个打架就退到笔画对比度。
///   Verdana / Tahoma 的大写 `I` 带横杠（比值 ≈ 3），`l` 是等宽竖干（≈ 1），
///   只信 `I` 会把这两个无衬线体判成衬线。
fn latin_verdict(m: &ShapeMetrics) -> Option<Classification> {
    m.stroke_contrast?; // 没有正常的 o 环 → 不是正文体骨架，不下结论
    let i = m.serif_ratio_i.and_then(ratio_verdict);
    let l = m.serif_ratio_l.and_then(ratio_verdict);
    match (i, l) {
        (Some(a), Some(b)) if a == b => Some(a),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        // 两个打架、或都给不出：退到笔画对比度
        _ => contrast_verdict(m),
    }
}

/// 衬线比 → 结论；落在不确定带返回 `None`。
fn ratio_verdict(ratio: f32) -> Option<Classification> {
    if ratio >= SERIF_RATIO_HI {
        Some(Classification::Serif)
    } else if ratio <= SERIF_RATIO_LO {
        Some(Classification::Sans)
    } else {
        None
    }
}

fn contrast_verdict(m: &ShapeMetrics) -> Option<Classification> {
    let c = m.stroke_contrast?;
    if c >= CONTRAST_HI {
        Some(Classification::Serif)
    } else if c <= CONTRAST_LO {
        Some(Classification::Sans)
    } else {
        None
    }
}

// ——————————————————————————————————————————————
// 取字形轮廓
// ——————————————————————————————————————————————

/// 取一个字符的轮廓并扁平化；字符不存在或没有轮廓（空格 / 图标字体没映射)返回 `None`。
fn contours_of(face: &ttf_parser::Face, ch: char) -> Option<Contours> {
    let gid = face.glyph_index(ch)?;
    let mut flattener = Flattener::default();
    face.outline_glyph(gid, &mut flattener)?;
    flattener.finish()
}

/// 把 `OutlineBuilder` 的路径段收成折线点集（曲线按固定步数细分）。
#[derive(Default)]
struct Flattener {
    contours: Contours,
    cur: Vec<(f32, f32)>,
    start: (f32, f32),
    pen: (f32, f32),
}

impl Flattener {
    fn close_contour(&mut self) {
        if self.cur.len() >= 3 {
            self.contours.push(std::mem::take(&mut self.cur));
        } else {
            self.cur.clear();
        }
    }

    /// 收尾：闭合最后一条 contour；一条有效 contour 都没有就返回 `None`。
    fn finish(mut self) -> Option<Contours> {
        self.close_contour();
        if self.contours.is_empty() {
            None
        } else {
            Some(self.contours)
        }
    }
}

impl ttf_parser::OutlineBuilder for Flattener {
    fn move_to(&mut self, x: f32, y: f32) {
        self.close_contour();
        self.start = (x, y);
        self.pen = (x, y);
        self.cur.push((x, y));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.cur.push((x, y));
        self.pen = (x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x0, y0) = self.pen;
        for i in 1..=QUAD_STEPS {
            let t = i as f32 / QUAD_STEPS as f32;
            let mt = 1.0 - t;
            self.cur.push((
                mt * mt * x0 + 2.0 * mt * t * x1 + t * t * x,
                mt * mt * y0 + 2.0 * mt * t * y1 + t * t * y,
            ));
        }
        self.pen = (x, y);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x0, y0) = self.pen;
        for i in 1..=CURVE_STEPS {
            let t = i as f32 / CURVE_STEPS as f32;
            let mt = 1.0 - t;
            let a = mt * mt * mt;
            let b = 3.0 * mt * mt * t;
            let c = 3.0 * mt * t * t;
            let d = t * t * t;
            self.cur.push((
                a * x0 + b * x1 + c * x2 + d * x,
                a * y0 + b * y1 + c * y2 + d * y,
            ));
        }
        self.pen = (x, y);
    }

    fn close(&mut self) {
        self.close_contour();
        self.pen = self.start;
    }
}

// ——————————————————————————————————————————————
// 几何基础（纯函数，测试里直接喂点集）
// ——————————————————————————————————————————————

/// 轮廓的紧密包围盒 `(x_min, x_max, y_min, y_max)`。
fn bounds(contours: &[Vec<(f32, f32)>]) -> Option<(f32, f32, f32, f32)> {
    let mut it = contours.iter().flatten();
    let (x0, y0) = *it.next()?;
    let (mut x_min, mut x_max, mut y_min, mut y_max) = (x0, x0, y0, y0);
    for &(x, y) in it {
        x_min = x_min.min(x);
        x_max = x_max.max(x);
        y_min = y_min.min(y);
        y_max = y_max.max(y);
    }
    Some((x_min, x_max, y_min, y_max))
}

/// 水平线 `y` 与所有轮廓的交点 x（升序）。
///
/// 用半开区间（`[y0, y1)`）判定，保证顶点只算一次、切线不会重复计数。
fn crossings_at_y(contours: &[Vec<(f32, f32)>], y: f32) -> Vec<f32> {
    let mut xs: Vec<f32> = Vec::new();
    for contour in contours {
        let n = contour.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let (x0, y0) = contour[i];
            let (x1, y1) = contour[(i + 1) % n];
            if (y0 <= y && y1 > y) || (y1 <= y && y0 > y) {
                let t = (y - y0) / (y1 - y0);
                xs.push(x0 + t * (x1 - x0));
            }
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    xs
}

/// 垂直线 `x` 与所有轮廓的交点 y（升序）。
fn crossings_at_x(contours: &[Vec<(f32, f32)>], x: f32) -> Vec<f32> {
    let mut ys: Vec<f32> = Vec::new();
    for contour in contours {
        let n = contour.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let (x0, y0) = contour[i];
            let (x1, y1) = contour[(i + 1) % n];
            if (x0 <= x && x1 > x) || (x1 <= x && x0 > x) {
                let t = (x - x0) / (x1 - x0);
                ys.push(y0 + t * (y1 - y0));
            }
        }
    }
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ys
}

/// 交点两两配对成「墨水段」；交点数为奇数（切线 / 数据异常）时返回空表示不可信。
fn ink_spans(xs: &[f32]) -> Vec<(f32, f32)> {
    if xs.len() < 2 || xs.len() % 2 != 0 {
        return Vec::new();
    }
    (0..xs.len() / 2).map(|i| (xs[2 * i], xs[2 * i + 1])).collect()
}

/// 水平线 `y` 处墨迹的总宽度（最左交点 → 最右交点）。
fn ink_extent_at_y(contours: &[Vec<(f32, f32)>], y: f32) -> Option<f32> {
    let xs = crossings_at_y(contours, y);
    if xs.len() < 2 {
        return None;
    }
    let extent = xs[xs.len() - 1] - xs[0];
    if extent > 0.0 {
        Some(extent)
    } else {
        None
    }
}

/// 竖直射线在 `x` 处的墨段（升序、两两配对）。
fn spans_at_x(contours: &[Vec<(f32, f32)>], x: f32) -> Vec<(f32, f32)> {
    ink_spans(&crossings_at_x(contours, x))
}

/// 水平射线在 `y` 处的墨段。
fn spans_at_y(contours: &[Vec<(f32, f32)>], y: f32) -> Vec<(f32, f32)> {
    ink_spans(&crossings_at_y(contours, y))
}

/// 竖直射线在 `x` 处**只穿过一段墨**时返回该段厚度。
///
/// 中文特征要求「一笔就是一整块」：3D 立体字、空心字、带描边装饰的字，一条射线会
/// 穿过好几段墨（正面 + 侧面 + 描边），这时候厚度比毫无意义，必须判不出。
/// 这一条把「康师傅」那类立体字挡在结论之外，让它们留在兜底展示。
fn single_span_thickness_at_x(contours: &[Vec<(f32, f32)>], x: f32) -> Option<f32> {
    match spans_at_x(contours, x).as_slice() {
        [(lo, hi)] => Some(hi - lo),
        _ => None,
    }
}

/// 水平射线在 `y` 处只穿过一段墨时返回该段厚度。
fn single_span_thickness_at_y(contours: &[Vec<(f32, f32)>], y: f32) -> Option<f32> {
    match spans_at_y(contours, y).as_slice() {
        [(lo, hi)] => Some(hi - lo),
        _ => None,
    }
}

// ——————————————————————————————————————————————
// 特征 1：拉丁衬线比
// ——————————————————————————————————————————————

/// 单个字形的衬线比：上 / 下衬线带的墨宽 ÷ 中间墨宽。
///
/// 衬线带取字高 0.8%–3% 之间的**最大值**，不是固定一条线 —— 衬线的上下缘是带弧的
/// 托架（bracket），越往里越窄：Times 的 `I` 在 2% 处还有 581 宽，到 4% 只剩 323，
/// 到 10% 就只剩竖干本体。取带内最大值才对「衬线多厚」这件事不敏感。
fn serif_ratio(contours: &[Vec<(f32, f32)>]) -> Option<f32> {
    let (_, _, y_min, y_max) = bounds(contours)?;
    let h = y_max - y_min;
    if h <= 0.0 {
        return None;
    }
    let mid = ink_extent_at_y(contours, (y_min + y_max) / 2.0)?;
    if mid <= 0.0 {
        return None;
    }
    let mut widest = 0.0f32;
    for frac in SERIF_BAND_FRACS {
        for y in [y_max - h * frac, y_min + h * frac] {
            if let Some(extent) = ink_extent_at_y(contours, y) {
                widest = widest.max(extent);
            }
        }
    }
    if widest <= 0.0 {
        return None;
    }
    Some(widest / mid)
}

/// 某个字符的衬线比；字符缺失或没有轮廓返回 `None`。
fn serif_ratio_of(face: &ttf_parser::Face, ch: char) -> Option<f32> {
    contours_of(face, ch).as_deref().and_then(serif_ratio)
}

// ——————————————————————————————————————————————
// 特征 2：拉丁笔画对比度
// ——————————————————————————————————————————————

/// 单个字形（`o` / `O`）的笔画对比度：竖画平均厚 ÷ 横画平均厚。
fn stroke_contrast(contours: &[Vec<(f32, f32)>]) -> Option<f32> {
    let (x_min, x_max, y_min, y_max) = bounds(contours)?;
    // 过字身中心的水平射线：两段墨 = 左右竖画
    let vertical = {
        let spans = ink_spans(&crossings_at_y(contours, (y_min + y_max) / 2.0));
        if spans.len() != 2 {
            return None;
        }
        ((spans[0].1 - spans[0].0) + (spans[1].1 - spans[1].0)) / 2.0
    };
    // 过字身中心的垂直线：两段墨 = 上下横画
    let horizontal = {
        let spans = ink_spans(&crossings_at_x(contours, (x_min + x_max) / 2.0));
        if spans.len() != 2 {
            return None;
        }
        ((spans[0].1 - spans[0].0) + (spans[1].1 - spans[1].0)) / 2.0
    };
    if vertical <= 0.0 || horizontal <= 0.0 {
        return None;
    }
    Some(vertical / horizontal)
}

/// 拉丁笔画对比度：`o` 优先，退化用 `O`。
fn latin_stroke_contrast(face: &ttf_parser::Face) -> Option<f32> {
    ['o', 'O']
        .iter()
        .find_map(|ch| contours_of(face, *ch).as_deref().and_then(stroke_contrast))
}

// ——————————————————————————————————————————————
// 特征 3：中文宋 / 黑
// ——————————————————————————————————————————————

fn mean_positive(values: &[f32]) -> Option<f32> {
    let (mut sum, mut n) = (0.0f32, 0usize);
    for v in values {
        if *v > 0.0 {
            sum += *v;
            n += 1;
        }
    }
    if n == 0 {
        None
    } else {
        Some(sum / n as f32)
    }
}

/// 「一」：两端厚度 ÷ 中段厚度。宋体两端有顿角（≥ 1.5），黑体等厚（≈ 1）。
///
/// 每个采样点都必须是**单段墨**（一笔），否则说明这个「一」是空心 / 立体 / 描边的
/// 美术字，返回 `None` 交给兜底展示。
fn han_end_ratio(contours: &[Vec<(f32, f32)>]) -> Option<f32> {
    let (x_min, x_max, _, _) = bounds(contours)?;
    let w = x_max - x_min;
    if w <= 0.0 {
        return None;
    }
    let mut samples: Vec<f32> = Vec::with_capacity(HAN_SCAN);
    for i in 0..HAN_SCAN {
        // 内缩 2%，避免采样点正好落在笔画末端之外
        let frac = 0.02 + 0.96 * ((i as f32 + 0.5) / HAN_SCAN as f32);
        let x = x_min + w * frac;
        samples.push(single_span_thickness_at_x(contours, x)?);
    }
    let left = mean_positive(&samples[..HAN_END_POINTS])?;
    let right = mean_positive(&samples[samples.len() - HAN_END_POINTS..])?;
    let mid = mean_positive(&samples[HAN_SCAN * 2 / 5..HAN_SCAN * 3 / 5])?;
    if mid <= 0.0 {
        return None;
    }
    Some(left.max(right) / mid)
}

/// 「十」：竖画厚度 ÷ 横画厚度。宋体横细竖粗（≥ 1.6），黑体等厚（≈ 1）。
///
/// 取「左 25% 处的竖直射线」量横画（那里只有横画），
/// 取「上 25% 处的水平射线」量竖画（那里只有竖画）。同样要求单段墨。
fn han_stroke_ratio(contours: &[Vec<(f32, f32)>]) -> Option<f32> {
    let (x_min, x_max, y_min, y_max) = bounds(contours)?;
    let (w, h) = (x_max - x_min, y_max - y_min);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let thin = single_span_thickness_at_x(contours, x_min + w * 0.25)?;
    let thick = single_span_thickness_at_y(contours, y_max - h * 0.25)?;
    if thin <= 0.0 {
        return None;
    }
    Some(thick / thin)
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 合成轮廓：直接喂点集测纯函数（说明性用例，不依赖任何字体文件） ——

    /// 无衬线的 `I`：一根等宽竖直矩形。
    fn sans_i() -> Contours {
        vec![vec![(150.0, 0.0), (250.0, 0.0), (250.0, 700.0), (150.0, 700.0)]]
    }

    /// 衬线的 `I`：竖干上下各一条更宽的横杠（400 宽 vs 100 宽）。
    fn serif_i() -> Contours {
        vec![vec![
            (0.0, 700.0),
            (400.0, 700.0),
            (400.0, 630.0),
            (250.0, 630.0),
            (250.0, 70.0),
            (400.0, 70.0),
            (400.0, 0.0),
            (0.0, 0.0),
            (0.0, 70.0),
            (150.0, 70.0),
            (150.0, 630.0),
            (0.0, 630.0),
        ]]
    }

    /// 无衬线的 `一`：等厚横条。
    fn sans_yi() -> Contours {
        vec![vec![(0.0, 0.0), (1000.0, 0.0), (1000.0, 60.0), (0.0, 60.0)]]
    }

    /// 宋体的 `一`：中段薄（40），两端厚（90，顿角）。
    fn song_yi() -> Contours {
        vec![vec![
            (0.0, 0.0),
            (1000.0, 0.0),
            (1000.0, 90.0),
            (930.0, 90.0),
            (930.0, 40.0),
            (70.0, 40.0),
            (70.0, 90.0),
            (0.0, 90.0),
        ]]
    }

    /// `十`：横画矩形 + 竖画矩形，厚度分别为 (thin, thick)。
    fn shi(thin: f32, thick: f32) -> Contours {
        vec![
            vec![(0.0, 400.0), (1000.0, 400.0), (1000.0, 400.0 + thin), (0.0, 400.0 + thin)],
            vec![(500.0 - thick / 2.0, 0.0), (500.0 + thick / 2.0, 0.0), (500.0 + thick / 2.0, 860.0), (500.0 - thick / 2.0, 860.0)],
        ]
    }

    #[test]
    fn straight_stem_has_no_serif_ratio() {
        let ratio = serif_ratio(&sans_i()).expect("sans I 该算得出比值");
        assert!((ratio - 1.0).abs() < 0.01, "等宽竖干比值应为 1，实际 {ratio}");
    }

    #[test]
    fn serif_bars_show_up_in_the_ratio() {
        let ratio = serif_ratio(&serif_i()).expect("serif I 该算得出比值");
        assert!(ratio >= SERIF_RATIO_HI, "上下横杠 400 / 竖干 100 应 ≥ 2，实际 {ratio}");
    }

    #[test]
    fn even_thickness_reads_as_sans_and_tapered_ends_as_serif() {
        let even = han_end_ratio(&sans_yi()).expect("等厚横条该算得出比值");
        assert!(even <= 1.05, "等厚应为 1，实际 {even}");
        let tapered = han_end_ratio(&song_yi()).expect("宋体横画该算得出比值");
        assert!(tapered >= HAN_END_HI, "两端 90 / 中段 40 应 ≥ 1.5，实际 {tapered}");
    }

    #[test]
    fn crossing_strokes_can_be_measured_separately() {
        let even = han_stroke_ratio(&shi(60.0, 60.0)).expect("等厚十字该算得出比值");
        assert!(even <= 1.05, "等厚应为 1，实际 {even}");
        let contrast = han_stroke_ratio(&shi(40.0, 70.0)).expect("横细竖粗该算得出比值");
        assert!(contrast >= HAN_STROKE_HI, "竖 70 / 横 40 应 ≥ 1.25，实际 {contrast}");
    }

    /// 空轮廓 / 退化轮廓不能 panic，也不能给出结论。
    #[test]
    fn degenerate_contours_are_rejected() {
        let empty: Contours = Vec::new();
        assert!(bounds(&empty).is_none());
        assert!(serif_ratio(&empty).is_none());
        assert!(stroke_contrast(&empty).is_none());
        assert!(han_end_ratio(&empty).is_none());
        assert!(han_stroke_ratio(&empty).is_none());
        // 两点 / 三点（退化多边形）也要安全
        let tiny: Contours = vec![vec![(0.0, 0.0), (10.0, 0.0), (10.0, 0.0)]];
        assert!(serif_ratio(&tiny).is_none());
        assert!(han_stroke_ratio(&tiny).is_none());
    }

    // —— 系统字体定标（缺文件就跳过，CI 上不红） ——

    /// 取系统字体的分类与指标；文件不存在返回 `None` 并打印说明。
    fn system_metrics(file: &str) -> Option<(String, ShapeMetrics, Option<Classification>)> {
        let path = std::path::Path::new(r"C:\Windows\Fonts").join(file);
        if !path.exists() {
            eprintln!("[skip] 系统字体缺失，跳过：{file}");
            return None;
        }
        let data = std::fs::read(&path).ok()?;
        let face = ttf_parser::Face::parse(&data, 0).ok()?;
        Some((
            file.to_string(),
            shape_metrics(&face),
            classify_by_shape(&face),
        ))
    }

    /// 阈值定标：这四条是「阈值站不站得住」的唯一证据。
    #[test]
    fn serif_ratio_separates_times_from_arial() {
        let Some((_, times, verdict)) = system_metrics("times.ttf") else {
            return;
        };
        let Some((_, arial, arial_verdict)) = system_metrics("arial.ttf") else {
            return;
        };
        eprintln!("times.ttf  {times:?} → {verdict:?}");
        eprintln!("arial.ttf  {arial:?} → {arial_verdict:?}");
        assert_eq!(verdict, Some(Classification::Serif), "Times New Roman 该判衬线");
        assert_eq!(arial_verdict, Some(Classification::Sans), "Arial 该判无衬线");
        assert!(
            times.serif_ratio_i.unwrap_or(0.0) > arial.serif_ratio_i.unwrap_or(9.0),
            "衬线比值必须明显大于无衬线"
        );
    }

    /// 中文宋 / 黑：两条特征都必须一致，宋体判衬线、黑体判无衬线。
    #[test]
    fn han_features_separate_song_from_hei() {
        let Some((_, song, song_verdict)) = system_metrics("simsun.ttc") else {
            return;
        };
        let Some((_, hei, hei_verdict)) = system_metrics("simhei.ttf") else {
            return;
        };
        eprintln!("simsun.ttc {song:?} → {song_verdict:?}");
        eprintln!("simhei.ttf {hei:?} → {hei_verdict:?}");
        assert_eq!(song_verdict, Some(Classification::Serif), "宋体该判衬线");
        assert_eq!(hei_verdict, Some(Classification::Sans), "黑体该判无衬线");
    }

    /// 微软雅黑：等厚笔画，应该判无衬线。
    #[test]
    fn yahei_reads_as_sans() {
        let Some((_, m, verdict)) = system_metrics("msyh.ttc") else {
            return;
        };
        eprintln!("msyh.ttc {m:?} → {verdict:?}");
        assert_eq!(verdict, Some(Classification::Sans), "微软雅黑该判无衬线");
    }

    /// 楷体：两条中文特征会互相打架（笔画有粗细变化但不成宋体规律），
    /// 允许判不出 —— 手写体不归字形层管，交给名字 / PANOSE / 兜底展示。
    #[test]
    fn kaiti_is_allowed_to_be_inconclusive() {
        let Some((_, m, verdict)) = system_metrics("simkai.ttf") else {
            return;
        };
        eprintln!("simkai.ttf {m:?} → {verdict:?}");
        assert_ne!(verdict, Some(Classification::Serif), "楷体不该被字形判成宋体");
    }

    /// 等宽字体走 `is_monospaced`，不归字形层管 —— 这里只确认它不会被误判成衬线。
    #[test]
    fn courier_shape_is_not_trusted() {
        let Some((_, m, verdict)) = system_metrics("cour.ttf") else {
            return;
        };
        eprintln!("cour.ttf {m:?} → {verdict:?}");
        // Courier 本身是 slab serif，字形层就算判成衬线也无所谓（等宽优先），
        // 这里只记录数值，不做「必须无衬线」的断言。
        assert!(m.serif_ratio_i.is_some(), "Courier 的 I 该算得出比值");
    }

    /// 陷阱回归：Verdana / Tahoma 的大写 `I` 天生带上下横杠（设计上为了跟 `l` 区分），
    /// 单看 `I` 的衬线比 ≈ 3 会把它们判成衬线；靠 `l`（等宽竖干，比值 ≈ 1）交叉作证
    /// 才能拨回来。这条是「必须两个字形对账」这个设计的唯一理由，钉住它。
    #[test]
    fn verdana_and_tahoma_are_not_serif() {
        for file in ["verdana.ttf", "tahoma.ttf"] {
            let Some((_, m, verdict)) = system_metrics(file) else {
                continue;
            };
            eprintln!("{file} {m:?} → {verdict:?}");
            assert!(
                m.serif_ratio_i.unwrap_or(0.0) >= SERIF_RATIO_HI,
                "{file} 的 I 本来就该像衬线 —— 这是陷阱本身，不是 bug"
            );
            assert_eq!(verdict, Some(Classification::Sans), "{file} 是无衬线");
        }
    }

    /// 诊断：把一批系统字体的四个几何指标 + 最终结论全打出来。
    /// 阈值定标、以及「哪些字体给不出结论」这两件事都靠它取证。
    ///
    /// 跑法：`cargo test --lib dump_shape_metrics -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dump_shape_metrics() {
        // (文件, 期望) —— 期望只用于人眼对照，不做断言（断言在各自的测试里）
        const CASES: &[(&str, &str)] = &[
            ("times.ttf", "serif"),
            ("georgia.ttf", "serif"),
            ("cambria.ttc", "serif"),
            ("pala.ttf", "serif"),
            ("constan.ttf", "serif"),
            ("book.ttf", "serif"),
            ("GARA.TTF", "serif"),
            ("CENTURY.TTF", "serif"),
            ("BKANT.TTF", "serif"),
            ("sylfaen.ttf", "serif"),
            ("arial.ttf", "sans"),
            ("verdana.ttf", "sans"),
            ("tahoma.ttf", "sans"),
            ("segoeui.ttf", "sans"),
            ("calibri.ttf", "sans"),
            ("trebuc.ttf", "sans"),
            ("corbel.ttf", "sans"),
            ("candara.ttf", "sans"),
            ("BAHNSCHRIFT.TTF", "sans"),
            ("cour.ttf", "mono"),
            ("consola.ttf", "mono"),
            ("simsun.ttc", "serif"),
            ("simhei.ttf", "sans"),
            ("msyh.ttc", "sans"),
            ("simkai.ttf", "script?"),
            ("simfang.ttf", "serif"),
            ("mingliu.ttc", "serif"),
            ("msjh.ttc", "sans"),
            ("YuGothM.ttc", "sans"),
            ("meiryo.ttc", "sans"),
            ("malgun.ttf", "sans"),
            ("wingding.ttf", "symbol"),
            ("symbol.ttf", "symbol"),
            ("webdings.ttf", "symbol"),
        ];
        for (file, want) in CASES {
            let path = std::path::Path::new(r"C://Windows//Fonts").join(file);
            let Ok(data) = std::fs::read(&path) else {
                println!("{file:20} [缺失]");
                continue;
            };
            let Ok(face) = ttf_parser::Face::parse(&data, 0) else {
                println!("{file:20} [解析失败]");
                continue;
            };
            let m = shape_metrics(&face);
            let verdict = match classify_by_shape(&face) {
                Some(c) => format!("{c:?}"),
                None => "None(无结论)".to_string(),
            };
            println!("{file:20} 期望={want:8} 结论={verdict:14} I={:.2?} l={:.2?} 对比度={:.2?} 一={:.2?} 十={:.2?}",
                m.serif_ratio_i, m.serif_ratio_l, m.stroke_contrast, m.han_end_ratio, m.han_stroke_ratio);
        }
    }
}

