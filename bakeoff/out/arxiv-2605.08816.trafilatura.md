#
![\[Uncaptioned image\]](2605.08816v1/images/titolo.png) on the Wall: Can VLM Agents Tell

Who They Are at All?

###### Abstract

In the animal kingdom, mirror self-recognition is a canonical probe of higher-order cognition, emerging only in some species. We ask whether an analogous functional capability emerges in embodied vision-language model (VLM) agents: can they recognize themselves in a mirror? We introduce a controlled 3D benchmark where a first-person VLM agent must infer a hidden body attribute from its reflection and select the matching target, while avoiding self–other misattribution. To separate mirror-grounded self-identification from shortcuts, we test mirror removal, misleading cues, and occluded reflections. We also evaluate the decision process through mirror seeking, temporal ordering, self-attribution, and reasoning–action consistency. Our experiments show that mirror-based self-identification emerges mainly in stronger VLMs. These models can use reflected evidence for action, whereas weaker models often inspect the mirror but fail to extract self-relevant information or misattribute their reflection. Language–vision conflict further shows that self-referential language alone is not evidence of grounded self-identification. Overall, mirror-based evaluation provides a diagnostic for whether embodied self-grounding is causally rooted in perception and action rather than priors, prompt compliance, or confabulation.

Keywords: Vision-Language Agents, Multimodal Reasoning, Self-Identification, Benchmark

## 1 Introduction

![Refer to caption](2605.08816v1/teaser.png)

Vision-language models (VLMs) are increasingly used as decision-making modules for embodied agents that must perceive, reason, and act under partial observability. This makes visual grounding essential: an agent must not only describe what it sees, but use visual evidence to choose actions. Despite strong progress in recognition, instruction following, navigation, and multimodal reasoning, current VLMs still suffer from hallucination, weak visual grounding, and failures in spatial reasoning [[38](#bib.bib21), [12](#bib.bib10), [25](#bib.bib11), [5](#bib.bib3)]. These limitations become especially important when the object of reasoning is not an external object, but the agent itself.

Self-identification is a basic requirement for embodied agency. An agent must distinguish its own body, state, and actions from those of other agents and objects. Under egocentric perception, however, self-relevant information is often outside the camera view and cannot be accessed directly. Mirrors provide a controlled way to test this ability: they reveal hidden body information while requiring the agent to attribute the reflected entity to itself and use that attribution for action.

Mirror self-recognition has long been studied in comparative cognition. Classic work showed that chimpanzees can use mirror reflections to guide self-directed behavior [[9](#bib.bib32)], and later studies reported related behavior in dolphins, elephants, and other species [[23](#bib.bib27), [21](#bib.bib34)]. Yet the interpretation of mirror-test success remains debated. It may reflect self-awareness, but it may also arise from sensorimotor matching, learned visual-proprioceptive associations, or task-specific strategies [[3](#bib.bib2), [39](#bib.bib22)]. This caution should also apply to embodied agents: fluent self-referential language or correct final actions are not sufficient evidence of grounded self-identification.

In this paper, we ask whether embodied VLM agents can perform mirror-guided self-identification (Fig. [1](#S1.F1)). We define this as a functional capability: an agent must use reflected visual evidence to infer a hidden attribute of its own body and then use that information to guide goal-directed behavior. This framing tests whether self-referential behavior is grounded in perception and action rather than produced by priors, prompt compliance, or confabulated explanations.

To study this question, we introduce a controlled benchmark<sup>1</sup><sup>1</sup>
            1

          Code & Benchmark are available at https://anonymous.4open.science/r/self-awareness-D446 in which a VLM-controlled agent observes the environment from a first-person perspective and must select the target object matching a hidden body attribute, i.e. its own body color. The attribute is not directly visible and can only be inferred through a mirror. We further introduce diagnostic interventions that remove the mirror, provide misleading linguistic cues, or degrade the reflection through occlusion. These conditions allow us to distinguish mirror-grounded self-identification from shortcut behavior, language bias, scene priors, and guessing.

A key aspect of our benchmark is that it evaluates both outcomes and decision processes. Target-selection accuracy indicates whether the agent acts correctly, but not whether the decision was grounded in mirror evidence. We therefore also measure mirror consultation, mirror gaze duration, temporal ordering between mirror observation and action, self-attribution in language, and confabulation. This process-level evaluation is necessary because embodied VLMs can appear competent while relying on weak grounding or non-visual shortcuts [[12](#bib.bib10), [25](#bib.bib11), [5](#bib.bib3)].

Our experiments show that mirror-guided self-identification can emerge in stronger VLM agents but remains fragile. Some models use reflected evidence to guide action, whereas others inspect the mirror without extracting the relevant self-attribute. We also find that self-referential language is not a reliable proxy for grounded self-identification: models often produce coherent first-person explanations even when mirror evidence is absent, misleading, or degraded. These results suggest that mirror-based evaluation is a useful diagnostic for embodied self-grounding in VLM agents.

Our contributions are as follows:

(i) we frame mirror-guided self-identification as a functional embodied capability for VLM agents and introduce a controlled 3D benchmark requiring agents to infer hidden self-relevant attributes from mirror evidence and act accordingly; (ii) we design interventions that remove mirror evidence, introduce misleading language, and degrade reflections to test whether behavior depends on visual self-grounding; (iii) we propose process-level metrics covering task success, evidence seeking, temporal ordering, self-attribution, and confabulation; (iv) we show that mirror-guided self-identification emerges mainly in stronger VLMs, whereas weaker agents often consult the mirror but fail to reliably use reflected evidence, frequently mistaking themselves for another agent.
## 2 Related Work

Vision-Language Models for Embodied Reasoning.
Vision-language models (VLMs) connect visual perception with language-conditioned reasoning and have shown strong zero-shot and few-shot performance across recognition, captioning, visual question answering, navigation, and multimodal reasoning [[38](#bib.bib21)].
In embodied settings, they can map visual observations and instructions into high-level plans or actions, but strong multimodal performance does not necessarily imply grounded visual reasoning: VLMs still suffer from hallucination, weak modality alignment, textual priors, and failures on spatially simple or perceptually grounded tasks [[14](#bib.bib5), [40](#bib.bib23), [32](#bib.bib17), [34](#bib.bib18), [16](#bib.bib7), [25](#bib.bib11)].
Recent work improves grounding through perception-language decomposition, self-rewarding, calibration, navigation history, and action-conditioned reasoning [[14](#bib.bib5), [40](#bib.bib23), [32](#bib.bib17), [12](#bib.bib10), [35](#bib.bib16)].
Our work shifts this focus from grounding external objects to grounding self-relevant visual information.

Multimodal Benchmarks, Shortcuts, and Process-Level Evaluation.
Recent multimodal benchmarks evaluate object hallucination, referential comprehension, compositional reasoning, self-consistency, and visual-language competence [[34](#bib.bib18), [16](#bib.bib7), [36](#bib.bib19), [33](#bib.bib15), [40](#bib.bib23), [27](#bib.bib14)].
These benchmarks show that high accuracy can still arise from shortcuts, including language priors, dataset regularities, or memorized correlations rather than genuine image use [[5](#bib.bib3)].
Vision-centric benchmarks such as NaturalBench and MMStar therefore design tasks that require image-grounded reasoning [[13](#bib.bib6), [5](#bib.bib3)].
This issue is central to embodied self-identification: an agent may choose the correct target without using the mirror, produce self-referential language without perceptual evidence, or misattribute its reflection to another entity.

Mirror Self-Recognition in Animals and Humans.
Mirror self-recognition has long been used as a behavioral probe of self-related processing in comparative cognition.
The classic mark-test paradigm reported that chimpanzees can use mirrors to guide self-directed behavior [[9](#bib.bib32)], and later work reported related findings in chimpanzees, orangutans, dolphins, elephants, magpies, and other species, while also documenting important species-level differences [[29](#bib.bib30), [10](#bib.bib24), [17](#bib.bib29), [23](#bib.bib27), [24](#bib.bib28), [39](#bib.bib22), [21](#bib.bib34)].
The interpretation of these results remains contested: mirror-test success may indicate self-awareness or self-concept, but it may also reflect sensorimotor matching, kinesthetic-visual correspondence, learned associations, or task-specific strategies [[19](#bib.bib31), [20](#bib.bib33), [8](#bib.bib25), [2](#bib.bib26), [4](#bib.bib35)].
We adopt this cautious interpretation and test mirror-guided self-identification as a functional capacity rather than as evidence of philosophical self-awareness.

Artificial Self-Recognition and Embodied Agency.
Artificial self-recognition has been studied in robotics and cognitive architectures through kinesthetic-visual matching, body-model learning, inner speech, multisensory integration, and sensorimotor contingencies [[11](#bib.bib4), [22](#bib.bib9), [37](#bib.bib20)].
These approaches relate to psychological and developmental accounts that distinguish first-order sensorimotor matching from more reflective self-awareness, and that emphasize action–perception coupling in distinguishing self from other [[18](#bib.bib8), [3](#bib.bib2), [28](#bib.bib13), [26](#bib.bib12)].
Unlike systems explicitly engineered for self-recognition, we test whether a general-purpose VLM agent can infer a hidden body attribute from first-person mirror evidence and use it for goal-directed action.

Positioning of This Work. Prior work shows that VLMs can perform well while relying on weak grounding, shortcuts, or textual priors, and that mirror self-recognition remains a contested but influential probe of self-related processing. We connect these threads by studying mirror-guided self-identification as a functional embodied capability. By measuring mirror consultation, temporal ordering, self-attribution, and confabulation, we distinguish mirror-grounded self-identification from shortcut behavior, prompt compliance, and misattribution of the agent’s own reflection.

## 3 Setup

### 3.1 Motivation and Research Question

We study whether an embodied VLM agent can treat visual observations as self-referential evidence. Rather than addressing self-awareness in a philosophical sense, we focus on a functional question: can an agent infer a hidden property of its own body from a reflection and use it to guide action?

The task is designed so that self-relevant information is never directly visible from the egocentric view. The agent must instead recover it indirectly through a reflective surface, under conditions that introduce ambiguity, distractors, misleading language, or degraded visual evidence. This allows us to distinguish mirror-grounded self-identification from guessing, prompt following, scene priors, or post-hoc confabulation.

### 3.2 Embodied Setting and Task

The agent operates in a simulated 3D environment from a first-person perspective. At each timestep $t\in\{1,\ldots,T\}$, it receives $x_{t}=\bigl(I_{t},h_{<t},p_{t},q\bigr)$ and outputs $y_{t}=\bigl(a_{t},\hat{c}^{\mathrm{self}}_{t},z_{t}\bigr)$, where $I_{t}$ is the current RGB observation, $h_{<t}$ is a compact action-position history, $p_{t}$ is the navigation state, $q$ is the task instruction, and $a_{t}\in\{\texttt{move\_forward},\texttt{move\_backward},\texttt{turn\_left},\texttt{turn\_right},\texttt{done}\}$ is the chosen action. The variable $\hat{c}^{\mathrm{self}}_{t}$ denotes the current self-attribution, while $z_{t}$ denotes the task-dependent decision field: cube selection in $E_{1}$–$E_{4}$ and final self-attribution in $E_{5}$.

Across all conditions, the agent’s true body color $c^{\star}$ is never directly visible from the egocentric view and must be inferred indirectly from perceptual evidence in the scene. The reflective mirror surface is not visually labeled, so successful behavior requires grounding self-identification in action-contingent and temporally consistent visual evidence, rather than relying only on priors or scene regularities.
A visual example of all the experimental setups is shown in Figure [2](#S3.F2), while details on the environment can be found in Appendix [A.7](#A1.SS7).

### 3.3 Experimental Conditions

E1: Active Mirror-Based Self-Identification. The agent is placed in a room with an unlabeled reflective surface and multiple colored cubes. Its body color is hidden from direct view. To solve the task, the agent must explore, discover the reflective evidence, infer its own body color, and navigate to the matching cube. This tests whether an embodied agent can identify itself through reflection rather than through chance or scene priors.

E2: Self-Identification Without Perceptual Evidence. This condition matches E1, but the reflective surface is removed. The agent must still select the cube corresponding to its own body color, although no visual evidence about this attribute is available. Performance should therefore collapse to chance; residual success indicates reliance on priors, prompt bias, scene regularities, or guessing.

E3: Self-Identification Under Conflicting Language. This condition matches E1, but the agent receives a misleading textual statement about its own body color that conflicts with the mirror evidence. The task tests whether the agent privileges visual self-evidence over false linguistic information, separating perceptual grounding from prompt compliance.

E4: Self–Other Disambiguation via Action. The agent is placed in a room with multiple other agents, ranging from one to six, which may have similar or identical body colors. All agents can appear both directly and through the reflective surface. The agent must identify which reflection is causally linked to its own actions and avoid misattributing another agent or reflection as itself, and then navigate to the cube matching its own body color.

E5: Robust Open-Ended Self-Attribution Under Clutter. Unlike $E_{1}$–$E_{4}$, E5 is an open-ended exploration probe rather than a cube-selection task. The agent explores a cluttered mirrored room with distractors and must decide when to terminate with a final self-attribution. This tests whether self-identification remains possible when mirror evidence is partial, noisy, or intermittently occluded.

Formally, for each condition $e\in\{E_{1},\dots,E_{5}\}$, let $\tau$ denote the first timestep at which the agent emits done, with the convention $\tau=T$ if no done action is produced. Let $c^{\star}$ denote the true body color of the ego agent. We define the final task decision as

|  | $$ \scriptstyle z_{\tau}^{(e)}=\begin{cases}\hat{c}^{\mathrm{cube}}_{\tau},&e\in\{E_{1},E_{2},E_{3},E_{4}\},\\[4.0pt] \hat{c}^{\mathrm{self}}_{\tau},&e=E_{5},\end{cases} $$ |  |

where $\hat{c}^{\mathrm{cube}}_{\tau}$ is the final selected cube color and $\hat{c}^{\mathrm{self}}_{\tau}$ is the final self-color attribution.

![Refer to caption](2605.08816v1/images/method.png)

### 3.4 Design Rationale

The task suite progressively probes embodied self-identification under increasing ambiguity. E1 tests the core capability, E2 removes perceptual evidence, E3 creates language–vision conflict, E4 introduces self–other ambiguity, and E5 tests robustness to degraded reflections. Together, these conditions ask whether VLM agents can recognize themselves in a mirror as a grounded functional capability, rather than merely produce correct answers or self-referential language.

### 3.5 Behavioral and Process-Level Measures

We evaluate both task outcomes and decision processes. Outcome metrics capture whether the agent selects the correct target, but this alone does not show whether the decision was grounded in mirror evidence. We therefore also measure whether the agent consults the mirror, whether mirror observation precedes action, whether the reflected body is attributed to the self, and whether the agent confabulates self-knowledge without evidence. Generally, for episode $i$, let

|  | $$ \tau_{i}=\min\{t:a_{i,t}=\texttt{done}\}, $$ |  |

with $\tau_{i}=T_{i}$ if no done action is produced. Let
$z^{(e)}_{i,\tau_{i}}$ denote the final task decision defined in Section [3.3](#S3.SS3), let
$c_{i}^{\star}$ be the true ego-agent color, and let $m_{i,t}\in\{0,1\}$ indicate
whether mirror evidence is visible at timestep $t$.

Task Success Accuracy (TSA) measures whether the agent reaches the correct final task decision Formally:

|  | $$ \scriptstyle\mathrm{TSA}_{i}=\begin{cases}1,&\text{if }z^{(e)}_{i,\tau_{i}}=c_{i}^{\star},\\ 0,&\text{otherwise.}\end{cases} $$ |  |

Time-to-Decision (TTD) measures the number of timesteps before termination:

|  | $$ \scriptstyle\mathrm{TTD}_{i}=\tau_{i}. $$ |  |

It helps separating immediate biased choices from decisions preceded by exploration.

Mirror Consultation Rate (MCR) measures whether the agent observes mirror evidence before committing to the final decision, distinguishing mirror-based decisions from visually unsupported ones.

|  | $$ \scriptstyle\mathrm{MCR}_{i}=\begin{cases}1,&\text{if there exists }t<\tau_{i}\text{ such that }m_{i,t}=1,\\ 0,&\text{otherwise.}\end{cases} $$ |  |

Mirror-Then-Action Temporal Ordering (MTATO) measures the fraction of successful episodes in which mirror consultation occurs before the final decision, testing whether correct behavior is temporally preceded by relevant evidence. For successful episodes only, we define

|  | $$ \scriptstyle\mathrm{MTATO}_{i}=\begin{cases}1,&\text{if }\mathrm{TSA}_{i}=1\text{ and there exists }t<\tau_{i}\text{ such that }m_{i,t}=1,\\ 0,&\text{if }\mathrm{TSA}_{i}=1\text{ and no such }t\text{ exists.}\end{cases} $$ |  |

We then report the mean of $\mathrm{MTATO}_{i}$ over successful episodes only.

Correct Attribution At Least Once (CAAL) measures whether the agent ever states the correct self-color before termination:

|  | $$ \scriptstyle\mathrm{CAAL}_{i}=\begin{cases}1,&\text{if there exists }t<\tau_{i}\text{ such that }\hat{c}^{\mathrm{self}}_{i,t}=c_{i}^{\star},\\ 0,&\text{otherwise.}\end{cases} $$ |  |

Confabulation Rate (CR) measures whether the agent commits to a self-attribution before observing mirror evidence. Let $t_{i}^{\mathrm{claim}}$ denote the first timestep before $\tau_{i}$ at which the agent outputs a self-color different from unknown, and let $t_{i}^{\mathrm{mirror}}$ denote the first timestep before $\tau_{i}$ at which mirror evidence becomes visible, whenever these timesteps exist. We define

|  | $$ \scriptstyle\mathrm{CR}_{i}=\begin{cases}1,&\text{if }t_{i}^{\mathrm{claim}}\text{ exists and either }t_{i}^{\mathrm{mirror}}\text{ does not exist}\\ &\text{or }t_{i}^{\mathrm{claim}}<t_{i}^{\mathrm{mirror}},\\ 0,&\text{otherwise.}\end{cases} $$ |  |

Together, these metrics separate mirror-grounded self-identification from superficially correct behavior, guessing, prompt compliance, and post-hoc explanation.

## 4 Results

We analyze the results with respect to the diagnostic questions and hypotheses defined in Sec. [3.3](#S3.SS3), as shown in Table [1](#S4.T1). The central goal is not only to determine whether an agent reaches the correct final task decision but also to ensure that correct behavior is supported by mirror-grounded self-identification. We therefore interpret the results through the three metric groups introduced in Sec. [3.5](#S3.SS5): task-success metrics, mirror-interaction quality metrics, and text-based metrics. This distinction is crucial: an agent may succeed by chance or shortcut, may inspect the mirror without extracting the relevant self-attribute, or may produce fluent self-referential language without perceptual grounding. For additional technical details, extended metrics, and qualitative examples, refer to Appendix [A](#A1).

We selected eight different VLMs to span the current frontier of multimodal agents across major providers (Anthropic [[1](#bib.bib39)], Google [[6](#bib.bib38)], OpenAI [[7](#bib.bib36)], Mistral [[15](#bib.bib40)], Qwen [[30](#bib.bib37)]) and a wide range of capability tiers, from compact open-weight models to flagship proprietary systems. This spread allows us to test whether mirror-guided self-identification scales with model strength or emerges only beyond a capability threshold. All VLM inference was performed via provider APIs; the only local compute requirement was a single workstation (128 GB RAM, NVIDIA RTX 2040 8 GB) used to run the MuJoCo [[31](#bib.bib1)] simulation and orchestrate API calls.

E1: Can an Embodied Agent Discover Who It Is by Looking at Its Reflection?
E1 evaluates the core capability targeted by the benchmark: whether an embodied VLM agent can discover a reflective surface, infer its hidden body color from the reflected body, attribute that reflection to itself, and use the inferred self-attribute to guide navigation. The results in Table [1](#S4.T1) and Figure [3](#S4.F3) provide evidence that this capability can emerge, but only for some models and not as a uniform property of VLM agents.

From the perspective of task success, Claude Sonnet 4.6 provides the strongest evidence of mirror-based self-identification, achieving TSA $=0.905\pm 0.066$. Qwen 3.6 Plus also performs strongly, with TSA $=0.714\pm 0.101$. These results show that some agents can solve the basic mirror-guided self-identification task. However, the capability is highly model-dependent: Ministral 3 14B reaches only TSA $=0.095\pm 0.066$, indicating that the task remains difficult even when the mirror is available.

The mirror-interaction metrics reveal the main diagnostic dissociation. High mirror consultation does not guarantee grounded self-identification. Gemma4 26B consults the mirror in every episode (MCR $=1.000\pm 0.000$) and has perfect temporal ordering (MTATO $=1.000\pm 0.000$), but reaches only TSA $=0.571\pm 0.111$. The same pattern is more pronounced for Ministral 3 14B, which has high MCR and perfect MTATO but very low TSA. Thus, the relevant failure is not merely failing to find the mirror, but failing to extract and use the reflected self-attribute.

Text-based metrics further caution against treating self-referential language as evidence of self-grounding. Claude Sonnet 4.6 achieves perfect CAAL but also a relatively high CR of $0.619\pm 0.109$, while Qwen 3.6 Plus combines strong TSA with CR $=0.571\pm 0.111$. Overall, E1 partially supports the hypothesis: some agents can use reflected evidence to infer who they are, but neither mirror consultation nor self-attribution alone is sufficient to establish grounded self-identification.

E2: What Does the Agent Do When the Mirror Is Gone?
E2 serves as a negative control by removing the mirror while leaving the task otherwise unchanged. Under the hypothesis in Sec. [3.3](#S3.SS3), performance should collapse when self-referential visual evidence is unavailable; any residual success should be interpreted as shortcut behavior, prior bias, or guessing rather than grounded self-identification.

The task-success metrics in Table [1](#S4.T1) and Figure [3](#S4.F3) broadly support this interpretation. Most models show low TSA when the mirror is removed: Ministral 3 14B reaches TSA $=0.000\pm 0.000$, Gemma4 31B reaches $0.048\pm 0.048$, Gemma4 26B reaches $0.095\pm 0.066$, and Qwen 3.6 Plus reaches $0.143\pm 0.078$. This drop relative to E1 supports the causal role of mirror evidence. However, Claude Sonnet 4.6 retains TSA $=0.524\pm 0.112$, and Gemini 2.5 Pro retains TSA $=0.381\pm 0.109$. Since the hidden body attribute is not visually observable in E2, these successes cannot be interpreted as self-identification and instead reveal residual shortcut or guessing behavior.

Mirror interaction collapses completely, with MCR $=0$ for all models and MTATO correspondingly zero or undefined, confirming that the relevant perceptual channel has been removed. More interestingly, TTD reveals two distinct response patterns: some models commit quickly despite lacking evidence, most clearly Gemini 2.5 Pro (TTD $=15.333\pm 2.493$, CR $=0.952\pm 0.048$), whereas others continue exploring much longer under uncertainty, such as GPT 5.1 (TTD $=98.476\pm 0.742$). Several agents continue to assert self-color identifications even when they lack perceptual access to the relevant visual evidence. Claude Sonnet 4.6 has CAAL $=0.762\pm 0.095$ but CR. $=1.000\pm 0.000$, while Gemini 2.5 Pro and Gemini 2.5 Flash reach CR. $=0.952\pm 0.048$ and $0.905\pm 0.066$, respectively. Thus, E2 strongly supports the negative-control hypothesis: without the mirror, agents often guess or confabulate, and fluent self-attribution is not evidence of grounded self-identification.

E3: Can the Agent Trust Its Eyes Over a False Belief About Itself?
E3 introduces a misleading textual statement about the agent’s body color while preserving access to the mirror. This condition tests whether the agent privileges reflected visual evidence over an incorrect linguistic prior. The results in Table [1](#S4.T1) show that this ability is limited and highly model-dependent.

Task success is substantially lower than in the clean mirror condition for several models. The best-performing model is GPT 5.1, with TSA $=0.524\pm 0.112$, followed by Qwen 3.6 Plus with TSA $=0.429\pm 0.111$ and Gemini 2.5 Pro with TSA $=0.381\pm 0.109$. The most striking degradation is observed for Claude Sonnet 4.6, which drops from TSA $=0.905\pm 0.066$ in E1 to $0.143\pm 0.078$ in E3. Thus, success in the clean mirror setting does not imply robustness to language–vision conflict.

The mirror-interaction metrics show that this degradation is not due to failure to consult the mirror. Several models have MCR $=1.000\pm 0.000$, including Claude Sonnet 4.6, Gemini 2.5 Flash, GPT 5.1, and Ministral 3 14B. MTATO is also perfect for all models with defined values. The main failure mode is therefore epistemic rather than exploratory: agents often access the relevant visual evidence but do not reliably resolve the conflict in favor of perception.

The text-based metrics reveal a further action–language dissociation. Gemini 2.5 Flash reaches CAAL $=0.952\pm 0.048$ but only TSA $=0.333\pm 0.105$, and Ministral 3 14B reaches CAAL $=0.762\pm 0.095$ but TSA $=0.238\pm 0.095$. These results show that correctly stating the self-color does not guarantee a correct embodied action. E3, therefore, only partially supports the hypothesis: agents can sometimes trust visual evidence over a false textual belief, but this ability is unstable and often breaks between verbal attribution and navigation.

E4: Can the Agent Tell Which Reflection Is Itself When Others Look Similar?
E4 probes self–other disambiguation. The hypothesis is that successful agents should go beyond static appearance matching and use action-contingent evidence to identify which reflected body corresponds to themselves. The results in Table [1](#S4.T1) and Figure [3](#S4.F3) suggest that some models can handle this ambiguity, but the capability remains fragile.

In terms of task success, Gemini 2.5 Pro performs best, with TSA $=0.714\pm 0.101$. Claude Sonnet 4.6 and Qwen 3.6 Plus both reach TSA $=0.667\pm 0.105$. These results indicate that self–other ambiguity does not fully prevent mirror-guided action for stronger models. However, the performance gap across models remains large: Gemma4 26B reaches only TSA $=0.190\pm 0.088$ despite high mirror consultation.

The mirror-interaction metrics again separate evidence seeking from self-identification. MCR is high for all models, and MTATO is generally high, but TSA varies widely. Gemma4 26B has MCR $=0.952\pm 0.048$ and MTATO $=1.000\pm 0.000$, but low TSA. Ministral 3 14B has MCR $=1.000\pm 0.000$ and MTATO $=1.000\pm 0.000$, but TSA $=0.333\pm 0.105$. These failures suggest that agents often inspect the mirror before acting, yet fail to determine which reflected entity is causally linked to themselves.

Text-based metrics remain only partially aligned with behavior. Stronger models often achieve high CAAL, including Claude Sonnet 4.6 with CAAL $=1.000\pm 0.000$ and Gemini 2.5 Pro with CAAL $=0.952\pm 0.048$. Overall, E4 partially supports the hypothesis: stronger agents can sometimes identify which reflection is themselves, but self–other disambiguation remains brittle and cannot be inferred from mirror consultation alone.

E5: Can the Agent Still Recognize Itself Through a Partially Occluded Reflection?

E5 tests robustness under degraded mirror evidence. If agents relied on robust causal or temporal cues rather than static visual matching alone, performance should degrade gradually under occlusion. The results in Table [1](#S4.T1) instead show a broad collapse, indicating that current mirror-guided self-identification remains brittle.

Task success is substantially reduced across models. Claude Sonnet 4.6 remains the strongest model but drops to TSA $=0.476\pm 0.112$. GPT 5.1 follows with TSA $=0.238\pm 0.095$, while most other models are near the bottom of the range: Gemma4 26B reaches TSA $=0.048\pm 0.048$, Gemma4 31B reaches $0.095\pm 0.066$, Qwen 3.6 Plus reaches $0.143\pm 0.078$, and Ministral 3 14B reaches $0.000\pm 0.000$.

The mirror-interaction metrics show that this failure is not caused by a lack of evidence seeking. MCR remains high for all models, ranging from $0.810\pm 0.088$ to $1.000\pm 0.000$. For instance, Ministral 3 14B has MCR $=1.000\pm 0.000$, yet obtains TSA $=0.000\pm 0.000$. Similarly, Gemini 2.5 Flash has perfect MCR, but TSA $=0.190\pm 0.088$. Hence, the limiting factor is not whether agents look at the mirror, but whether they can interpret incomplete reflected evidence.

The text-based metrics show a distinctive form of failure. CAAL collapses to zero or near zero for most models, including Claude Sonnet 4.6, Gemma4 26B, Gemma4 31B, and GPT 5.1, while CR is near zero across almost all models. This should not be interpreted as improved grounding; rather, many agents fail to make a concrete self-attribution at all under extended uncertainty. E5 therefore demonstrates that mirror access alone is insufficient for robust self-identification in open-ended settings. Although agents continue to seek mirror evidence, they generally fail to use it effectively when the reflection is partially occluded, thereby rejecting the robustness hypothesis.

| Model | TSA $\uparrow$ | TTD $\downarrow$ | MCR $\uparrow$ | MTATO $\uparrow$ | CAAL $\uparrow$ | CR $\downarrow$ |
|---|---|---|---|---|---|---|
| E1: Active mirror-based self-identification |  |  |  |  |  |  |
| Ministral 3 14B | $0.10\pm 0.07$ | $94.43\pm 3.56$ | $0.86\pm 0.08$ | $\mathbf{1.00\pm 0.00}$ | $0.67\pm 0.11$ | $0.24\pm 0.10$ |
| Gemma4 26B | $0.57\pm 0.11$ | $93.43\pm 4.08$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.91\pm 0.07}$ | $\underline{0.19\pm 0.09}$ |
| Gemma4 31B | $0.57\pm 0.11$ | $47.67\pm 8.15$ | $0.71\pm 0.10$ | $0.58\pm 0.15$ | $0.52\pm 0.11$ | $\mathbf{0.14\pm 0.08}$ |
| Gemini 2.5 Flash | $0.43\pm 0.11$ | $73.43\pm 7.63$ | $0.76\pm 0.10$ | $0.67\pm 0.17$ | $0.76\pm 0.10$ | $0.43\pm 0.11$ |
| Gemini 2.5 Pro | $0.43\pm 0.11$ | $\mathbf{24.48\pm 4.27}$ | $0.76\pm 0.10$ | $0.78\pm 0.15$ | $0.76\pm 0.10$ | $0.24\pm 0.10$ |
| Qwen 3.6 Plus | $\underline{0.71\pm 0.10}$ | $\underline{37.10\pm 6.33}$ | $0.71\pm 0.10$ | $0.80\pm 0.11$ | $0.76\pm 0.10$ | $0.57\pm 0.11$ |
| GPT 5.1 | $0.52\pm 0.11$ | $58.71\pm 8.24$ | $0.91\pm 0.07$ | $\mathbf{1.00\pm 0.00}$ | $0.81\pm 0.09$ | $0.33\pm 0.11$ |
| Claude Sonnet 4.6 | $\mathbf{0.91\pm 0.07}$ | $76.33\pm 6.24$ | $\underline{0.95\pm 0.05}$ | $\underline{0.95\pm 0.05}$ | $\mathbf{1.00\pm 0.00}$ | $0.62\pm 0.11$ |
| E2: Self-identification without mirror evidence |  |  |  |  |  |  |
| Ministral 3 14B | $0.00\pm 0.00$ | $95.62\pm 3.06$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.10\pm 0.07$ | $\mathbf{0.24\pm 0.10}$ |
| Gemma4 26B | $0.10\pm 0.07$ | $83.43\pm 7.49$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.10\pm 0.07$ | $0.43\pm 0.11$ |
| Gemma4 31B | $0.05\pm 0.05$ | $78.33\pm 7.10$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.05\pm 0.05$ | $\underline{0.33\pm 0.11}$ |
| Gemini 2.5 Flash | $0.10\pm 0.07$ | $94.67\pm 3.94$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.14\pm 0.08$ | $0.91\pm 0.07$ |
| Gemini 2.5 Pro | $\underline{0.38\pm 0.11}$ | $\mathbf{15.33\pm 2.49}$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $\underline{0.52\pm 0.11}$ | $0.95\pm 0.05$ |
| Qwen 3.6 Plus | $0.14\pm 0.08$ | $\underline{67.67\pm 8.94}$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.14\pm 0.08$ | $0.76\pm 0.10$ |
| GPT 5.1 | $0.19\pm 0.09$ | $98.48\pm 0.74$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.00\pm 0.00$ | $0.38\pm 0.11$ |
| Claude Sonnet 4.6 | $\mathbf{0.52\pm 0.11}$ | $91.67\pm 2.55$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.76\pm 0.10}$ | $1.00\pm 0.00$ |
| E3: Self-identification under conflicting linguistic information |  |  |  |  |  |  |
| Ministral 3 14B | $0.24\pm 0.10$ | $84.33\pm 5.83$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.76\pm 0.10$ | $\mathbf{0.19\pm 0.09}$ |
| Gemma4 26B | $0.29\pm 0.10$ | $57.90\pm 10.07$ | $0.67\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $0.62\pm 0.11$ | $\mathbf{0.19\pm 0.09}$ |
| Gemma4 31B | $0.33\pm 0.11$ | $\mathbf{20.00\pm 7.44}$ | $0.57\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $0.33\pm 0.11$ | $\mathbf{0.19\pm 0.09}$ |
| Gemini 2.5 Flash | $0.33\pm 0.11$ | $73.71\pm 7.21$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{0.95\pm 0.05}$ | $0.52\pm 0.11$ |
| Gemini 2.5 Pro | $0.38\pm 0.11$ | $\underline{52.81\pm 9.18}$ | $\underline{0.95\pm 0.05}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.81\pm 0.09}$ | $0.52\pm 0.11$ |
| Qwen 3.6 Plus | $\underline{0.43\pm 0.11}$ | $57.10\pm 8.98$ | $0.86\pm 0.08$ | $\mathbf{1.00\pm 0.00}$ | $0.71\pm 0.10$ | $0.48\pm 0.11$ |
| GPT 5.1 | $\mathbf{0.52\pm 0.11}$ | $57.19\pm 7.84$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.62\pm 0.11$ | $0.57\pm 0.11$ |
| Claude Sonnet 4.6 | $0.14\pm 0.08$ | $75.67\pm 7.57$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.29\pm 0.10$ | $\underline{0.38\pm 0.11}$ |
| E4: Self–other disambiguation under visual ambiguity |  |  |  |  |  |  |
| Ministral 3 14B | $0.33\pm 0.11$ | $80.57\pm 7.17$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.81\pm 0.09$ | $\underline{0.24\pm 0.10}$ |
| Gemma4 26B | $0.19\pm 0.09$ | $87.52\pm 4.15$ | $\underline{0.95\pm 0.05}$ | $\mathbf{1.00\pm 0.00}$ | $0.62\pm 0.11$ | $0.38\pm 0.11$ |
| Gemma4 31B | $0.38\pm 0.11$ | $45.05\pm 7.32$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.48\pm 0.11$ | $\mathbf{0.14\pm 0.08}$ |
| Gemini 2.5 Flash | $0.38\pm 0.11$ | $62.76\pm 8.46$ | $\underline{0.95\pm 0.05}$ | $0.88\pm 0.13$ | $0.86\pm 0.08$ | $0.38\pm 0.11$ |
| Gemini 2.5 Pro | $\mathbf{0.71\pm 0.10}$ | $\underline{42.57\pm 6.03}$ | $\underline{0.95\pm 0.05}$ | $\underline{0.93\pm 0.07}$ | $\underline{0.95\pm 0.05}$ | $0.48\pm 0.11$ |
| Qwen 3.6 Plus | $\underline{0.67\pm 0.11}$ | $\mathbf{40.43\pm 6.39}$ | $0.86\pm 0.08$ | $\underline{0.93\pm 0.07}$ | $0.76\pm 0.10$ | $0.48\pm 0.11$ |
| GPT 5.1 | $0.38\pm 0.11$ | $75.29\pm 6.11$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.76\pm 0.10$ | $\underline{0.24\pm 0.10}$ |
| Claude Sonnet 4.6 | $\underline{0.67\pm 0.11}$ | $78.67\pm 6.75$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.48\pm 0.11$ |
| E5: Robust self-identification under occlusion |  |  |  |  |  |  |
| Ministral 3 14B | $0.00\pm 0.00$ | $93.43\pm 4.14$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $\underline{0.05\pm 0.05}$ | $\mathbf{0.00\pm 0.00}$ |
| Gemma4 26B | $0.05\pm 0.05$ | $84.57\pm 6.86$ | $0.81\pm 0.09$ | $\mathbf{1.00\pm 0.00}$ | $0.00\pm 0.00$ | $\underline{0.05\pm 0.05}$ |
| Gemma4 31B | $0.10\pm 0.07$ | $70.00\pm 6.93$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.00\pm 0.00$ | $\mathbf{0.00\pm 0.00}$ |
| Gemini 2.5 Flash | $0.19\pm 0.09$ | $88.86\pm 3.90$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{0.19\pm 0.09}$ | $\mathbf{0.00\pm 0.00}$ |
| Gemini 2.5 Pro | $0.19\pm 0.09$ | $\mathbf{33.19\pm 5.21}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.05\pm 0.05}$ | $\mathbf{0.00\pm 0.00}$ |
| Qwen 3.6 Plus | $0.14\pm 0.08$ | $75.57\pm 8.12$ | $\underline{0.95\pm 0.05}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.05\pm 0.05}$ | $\mathbf{0.00\pm 0.00}$ |
| GPT 5.1 | $\underline{0.24\pm 0.10}$ | $99.19\pm 0.15$ | $\underline{0.95\pm 0.05}$ | $\mathbf{1.00\pm 0.00}$ | $0.00\pm 0.00$ | $\mathbf{0.00\pm 0.00}$ |
| Claude Sonnet 4.6 | $\mathbf{0.48\pm 0.11}$ | $\underline{62.10\pm 3.43}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $0.00\pm 0.00$ | $\mathbf{0.00\pm 0.00}$ |

## 5 Conclusions

We introduced a controlled benchmark for functional mirror-guided self-identification in embodied VLM agents. Our results show that this capability can emerge, but it remains partial, fragile, and strongly model-dependent. Performance is highest in the clean mirror condition, but drops when mirror evidence is removed, when language conflicts with perception, and under self–other ambiguity or cluttered reflected scenes. This supports the causal role of reflected visual evidence while also showing that success in the basic condition should not be overinterpreted as robust self-awareness-like behavior.

Across conditions, the main pattern is a dissociation between accessing evidence and using it. Many agents consult the mirror, often before acting, yet still fail to extract the relevant self-attribute or translate it into the correct final decision. Language introduces a second dissociation: agents can produce plausible or even correct self-attributions without reliable perceptual grounding, as shown by confabulation in the no-mirror control and by the gap between CAAL and TSA under misleading language. Overall, the strongest evidence for mirror-grounded self-identification appears only when task success, mirror consultation, temporal ordering, and correct self-attribution align.

Limitations and Future Work. This work should be interpreted as a test of functional mirror-guided self-identification, not as philosophical self-awareness. Moreover, VLMs may still partly rely on pretraining priors about mirrors and reflections. We mitigate this by using an unlabeled reflective surface and by avoiding an explicit, canonical mirror frame in the environment. This design reduces direct semantic shortcuts, although it cannot fully eliminate learned visual priors about reflective surfaces.Future work should extend this setting to multi-agent scenarios, collaborative tasks, video-based evaluation, and action-conditioned world models to test whether stronger representations of action consequences improve embodied self-grounding.

## References

- [1]
 (2026)
Introducing Claude Sonnet 4.6.
Note: Accessed: 2026-05-07
External Links: [Link](https://www.anthropic.com/news/claude-sonnet-4-6) Cited by:[§4](#S4.p2.1) .
- [2]
 (2004)
Reflections on animal selves.
Trends in Ecology & Evolution 19 (4), pp. 176–180.
Cited by: [§2](#S2.p3.1) .
- [3]
 (2018)
The puzzle of mirror self-recognition.
Phenomenology and the Cognitive Sciences 17, pp. 279–304.
External Links: [Document](https://dx.doi.org/10.1007/s11097-016-9486-7) Cited by:[§1](#S1.p3.1) ,[§2](#S2.p4.1) .
- [4]
 (2017)
Spontaneous expression of mirror self-recognition in monkeys after learning precise visual-proprioceptive association for mirror images.
Proceedings of the National Academy of Sciences 114 (12), pp. 3258–3263.
External Links: [Document](https://dx.doi.org/10.1073/pnas.1620764114) Cited by:[§2](#S2.p3.1) .
- [5]
 (2024)
Are we on the right way for evaluating large vision-language models?.
ArXiv abs/2403.20330.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2403.20330) Cited by:[§1](#S1.p1.1) ,[§1](#S1.p6.1) ,[§2](#S2.p2.1) .
- [6]
 (2025)
Gemini 2.5: pushing the frontier with advanced reasoning, multimodality, long context, and next generation agentic capabilities.
arXiv preprint arXiv:2507.06261.
External Links: [Link](https://arxiv.org/abs/2507.06261) Cited by:[§4](#S4.p2.1) .
- [7]
 (2026)
OpenAI gpt-5 system card.
External Links: 2601.03267,
[Link](https://arxiv.org/abs/2601.03267) Cited by:[§4](#S4.p2.1) .
- [8]
 (2002)
The mirror test.
In The Cognitive Animal: Empirical and Theoretical Perspectives on Animal Cognition,  M. Bekoff, C. Allen, and G. M. Burghardt (Eds.),
Cited by: [§2](#S2.p3.1) .
- [9]
 (1970)
Chimpanzees: self-recognition.
Science 167 (3914), pp. 86–87.
External Links: [Document](https://dx.doi.org/10.1126/science.167.3914.86) Cited by:[§1](#S1.p3.1) ,[§2](#S2.p3.1) .
- [10]
 (1982)
Self-awareness and the emergence of mind in primates.
American Journal of Primatology 2, pp. 237–248.
Cited by: [§2](#S2.p3.1) .
- [11]
 (2020)
Robot in the mirror: toward an embodied computational model of mirror self-recognition.
KI - Künstliche Intelligenz 35, pp. 37 – 51.
External Links: [Document](https://dx.doi.org/10.1007/s13218-020-00701-7) Cited by:[§2](#S2.p4.1) .
- [12]
 (2019)
Are you looking? grounding to multiple modalities in vision-and-language navigation.
In Proceedings of the 57th Annual Meeting of the Association for Computational Linguistics,
pp. 6551–6557.
Cited by: [§1](#S1.p1.1) ,[§1](#S1.p6.1) ,[§2](#S2.p1.1) .
- [13]
 (2024)
NaturalBench: evaluating vision-language models on natural adversarial samples.
ArXiv abs/2410.14669.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2410.14669) Cited by:[§2](#S2.p2.1) .
- [14]
 (2025)
Self-rewarding vision-language model via reasoning decomposition.
ArXiv abs/2508.19652.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2508.19652) Cited by:[§2](#S2.p1.1) .
- [15]
 (2026)
Ministral 3.
arXiv preprint arXiv:2601.08584.
Cited by: [§4](#S4.p2.1) .
- [16]
 (2023)
MMBench: is your multi-modal model an all-around player?.
ArXiv abs/2307.06281.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2307.06281) Cited by:[§2](#S2.p1.1) ,[§2](#S2.p2.1) .
- [17]
 (1994)
Evidence of self-awareness in the bottlenose dolphin (Tursiops truncatus).
 Cambridge University Press.
Cited by: [§2](#S2.p3.1) .
- [18]
 (1993)
Mental models of mirror-self-recognition: two theories.
New Ideas in Psychology 11, pp. 295–325.
External Links: [Document](https://dx.doi.org/10.1016/0732-118x%2893%2990002-u) Cited by:[§2](#S2.p4.1) .
- [19]
 (1997)
Kinesthetic-visual matching and the self-concept as explanations of mirror-self-recognition.
Journal for the Theory of Social Behaviour 27 (1).
Cited by: [§2](#S2.p3.1) .
- [20]
 (1989)
Gallup’s mirrors: more than an operationalization of self-awareness in primates?.
Psychological Reports 65 (1), pp. 287–291.
External Links: [Document](https://dx.doi.org/10.2466/pr0.1989.65.1.287) Cited by:[§2](#S2.p3.1) .
- [21]
 (2018)
Precocious development of self-awareness in dolphins.
PLoS One 13 (1), pp. e0189813.
Cited by: [§1](#S1.p3.1) ,[§2](#S2.p3.1) .
- [22]
 (2021)
Robot passes the mirror test by inner speech.
Robotics Auton. Syst. 144, pp. 103838.
External Links: [Document](https://dx.doi.org/10.1016/j.robot.2021.103838) Cited by:[§2](#S2.p4.1) .
- [23]
 (2006)
Self-recognition in an asian elephant.
Proceedings of the National Academy of Sciences 103 (45), pp. 17053–17057.
Cited by: [§1](#S1.p3.1) ,[§2](#S2.p3.1) .
- [24]
 (2008)
Mirror-induced behavior in the magpie (Pica pica): evidence of self-recognition.
PLoS Biology 6 (8), pp. e202.
Cited by: [§2](#S2.p3.1) .
- [25]
 (2024)
Vision language models are blind.
ArXiv abs/2407.06581.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2407.06581) Cited by:[§1](#S1.p1.1) ,[§1](#S1.p6.1) ,[§2](#S2.p1.1) .
- [26]
 (2022)
Multisensory and sensorimotor integration in the embodied self: relationship between self-body recognition and the mirror neuron system.
Sensors (Basel, Switzerland) 22.
External Links: [Document](https://dx.doi.org/10.3390/s22135059) Cited by:[§2](#S2.p4.1) .
- [27]
 (2022)
When service robots look at themselves in the mirror: an examination of the effects of perceptions of robotic self-recognition.
Journal of Retailing and Consumer Services.
External Links: [Document](https://dx.doi.org/10.1016/j.jretconser.2021.102820) Cited by:[§2](#S2.p2.1) .
- [28]
 (2008)
The robot in the mirror.
Connection Science 20 (4), pp. 337–358.
Cited by: [§2](#S2.p4.1) .
- [29]
 (1981)
Self-recognition in chimpanzees and orangutans, but not gorillas.
Journal of Human Evolution 10 (2), pp. 175–188.
Cited by: [§2](#S2.p3.1) .
- [30]
 (2025)
Qwen3 technical report.
arXiv preprint arXiv:2505.09388.
External Links: [Link](https://arxiv.org/abs/2505.09388) Cited by:[§4](#S4.p2.1) .
- [31]
 (2012)
MuJoCo: a physics engine for model-based control.
In 2012 IEEE/RSJ International Conference on Intelligent Robots and Systems,
pp. 5026–5033.
External Links: [Document](https://dx.doi.org/10.1109/IROS.2012.6386109) Cited by:[§A.7](#A1.SS7.p1.1) ,[Table 4](#A1.T4.3.2.2.1.1) ,[§4](#S4.p2.1) .
- [32]
 (2024)
Enhancing visual-language modality alignment in large vision language models via self-improvement.
ArXiv abs/2405.15973.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2405.15973) Cited by:[§2](#S2.p1.1) .
- [33]
 (2025)
Enhancing visual-language modality alignment in large vision language models via self-improvement.
In Findings of the Association for Computational Linguistics: NAACL 2025,
pp. 268–282.
Cited by: [§2](#S2.p2.1) .
- [34]
 (2024)
Lvlm-ehub: a comprehensive evaluation benchmark for large vision-language models.
IEEE Transactions on Pattern Analysis and Machine Intelligence 47 (3), pp. 1877–1893.
Cited by: [§2](#S2.p1.1) ,[§2](#S2.p2.1) .
- [35]
 (2019)
Embodied visual recognition.
arXiv preprint arXiv:1904.04404.
Cited by: [§2](#S2.p1.1) .
- [36]
 (2024)
SC- tune: unleashing self-consistent referential comprehension in large vision language models.
In 2024 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR),
pp. 13073–13083.
External Links: [Document](https://dx.doi.org/10.1109/cvpr52733.2024.01242) Cited by:[§2](#S2.p2.1) .
- [37]
 (2017)
Toward robot self-consciousness (ii): brain-inspired robot bodily self model for self-recognition.
Cognitive Computation 10, pp. 307 – 320.
External Links: [Document](https://dx.doi.org/10.1007/s12559-017-9505-1) Cited by:[§2](#S2.p4.1) .
- [38]
 (2023)
Vision-language models for vision tasks: a survey.
IEEE Transactions on Pattern Analysis and Machine Intelligence 46, pp. 5625–5644.
External Links: [Document](https://dx.doi.org/10.1109/tpami.2024.3369699) Cited by:[§1](#S1.p1.1) ,[§2](#S2.p1.1) .
- [39]
 (2015)
Monkeys pass the mirror test after training.
Science China. Life Sciences 58 (4), pp. 405.
Cited by: [§1](#S1.p3.1) ,[§2](#S2.p3.1) .
- [40]
 (2024)
Calibrated self-rewarding vision language models.
ArXiv abs/2405.14622.
External Links: [Document](https://dx.doi.org/10.48550/arxiv.2405.14622) Cited by:[§2](#S2.p1.1) ,[§2](#S2.p2.1) .

## Appendix A Additional Results

### A.1 Auxiliary Metrics and Relative Results

In addition to the core metrics reported in the main paper, we retain four auxiliary metrics that provide additional diagnostic information about completion policy, persistence of mirror exposure, and belief revision. These metrics were excluded from the main text because they are either partially conditioned or secondary to the core task-level measures, but they remain useful in the supplementary analyses below.

Using the notation introduced in Sec. [A.6](#A1.SS6), let $T_{i}$ denote
the length of episode $i$, $\tau_{i}$ the first timestep at which the agent
outputs done when such a timestep exists, $c_{i}^{\star}$ the ground-truth
body color, $\hat{c}_{i,t}$ the self-color reported at timestep $t$, and
$m_{i,t}\in\{0,1\}$ whether mirror evidence is visible at timestep $t$.

#### Completion-Conditioned Task Success.

Let $C_{i}=\mathbf{1}[\tau_{i}\text{ exists}]$ denote the indicator that episode $i$ terminates with done. The completion-conditioned success rate is

|  | $$ \mathrm{TSA}_{\mathrm{complete}}=\frac{\sum_{i}C_{i}\,\mathrm{TSA}_{i}}{\sum_{i}C_{i}}, $$ |  |

and is reported in tables as TSA-C. This quantity separates incorrect final decisions from failure to terminate appropriately.

#### Mirror Gaze Duration.

Mirror Gaze Duration is defined at the episode level as

|  | $$ \mathrm{MGD}_{i}=\sum_{t=1}^{T_{i}}m_{i,t}, $$ |  |

that is, the number of timesteps in which mirror evidence is visible during the trajectory. It measures persistence of mirror exposure rather than successful use of that exposure.

#### Self-Correction.

Let

|  | $$ t_{i}^{\mathrm{mirror}}=\min\{t:m_{i,t}=1\} $$ |  |

denote the first timestep at which mirror evidence becomes available, whenever such a timestep exists. Let

|  | $$ t_{i}^{\mathrm{guess}}=\min\{t<t_{i}^{\mathrm{mirror}}:\hat{c}_{i,t}\notin\{\texttt{unknown},\texttt{null},\varnothing\}\} $$ |  |

denote the first committed pre-mirror self-attribution, when it exists. The self-correction applicability indicator is

|  | $$ A_{i}=\mathbf{1}\!\left[t_{i}^{\mathrm{mirror}}\text{ exists},\;t_{i}^{\mathrm{guess}}\text{ exists},\;\hat{c}_{i,t_{i}^{\mathrm{guess}}}\neq c_{i}^{\star}\right]. $$ |  |

For applicable episodes, self-correction is defined as

|  | $$ \mathrm{SC}_{i}=\mathbf{1}\!\left[\exists t\in[t_{i}^{\mathrm{mirror}},\tilde{\tau}_{i}]\text{ such that }\hat{c}_{i,t}=c_{i}^{\star}\right], $$ |  |

where $\tilde{\tau}_{i}=\tau_{i}$ if the episode terminates and $\tilde{\tau}_{i}=T_{i}$ otherwise.

#### Applicability Rate.

Because self-correction is meaningful only for episodes in which a wrong pre-mirror self-attribution is made, we also report the self-correction applicability rate

|  | $$ \mathrm{AR}_{\mathrm{SC}}=\frac{1}{N}\sum_{i}A_{i}, $$ |  |

together with the correction rate

|  | $$ \mathrm{SC}=\frac{\sum_{i}A_{i}\,\mathrm{SC}_{i}}{\sum_{i}A_{i}}. $$ |  |

Thus, $\mathrm{AR}_{\mathrm{SC}}$ measures how often the model enters a state where correction is possible, whereas $\mathrm{SC}$ measures how often it successfully revises the initial wrong self-attribution once mirror evidence becomes available.

Table [2](#A1.T2) reports an extended view of the
results, combining selected core metrics with the auxiliary metrics introduced above. The table is organized to highlight completion policy, persistence of mirror exposure, revision behavior, and language-side diagnostics.

| Model | TSA $\uparrow$ | TSA-C $\uparrow$ | MCR $\uparrow$ | MGD $\uparrow$ | CAAL $\uparrow$ | SC $\uparrow$ | AR <sub>SC</sub> $\uparrow$ |
|---|---|---|---|---|---|---|---|
| E1: Active mirror-based self-identification |  |  |  |  |  |  |  |
| Ministral 3 14B | $0.10\pm 0.07$ | $0.67\pm 0.33$ | $0.86\pm 0.08$ | $11.81\pm 2.79$ | $0.67\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $0.10\pm 0.06$ |
| Gemma4 26B | $0.57\pm 0.11$ | $\underline{0.80\pm 0.11}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{28.48\pm 4.53}$ | $\underline{0.90\pm 0.07}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.14\pm 0.08}$ |
| Gemma4 31B | $0.57\pm 0.11$ | $\underline{0.80\pm 0.11}$ | $0.71\pm 0.10$ | $7.48\pm 2.14$ | $0.52\pm 0.11$ | – | $0.00\pm 0.00$ |
| Gemini 2.5 Flash | $0.43\pm 0.11$ | $0.60\pm 0.13$ | $0.76\pm 0.10$ | $10.76\pm 2.41$ | $0.76\pm 0.10$ | $\mathbf{1.00\pm 0.00}$ | $0.05\pm 0.05$ |
| Gemini 2.5 Pro | $0.43\pm 0.11$ | $0.43\pm 0.11$ | $0.76\pm 0.10$ | $6.86\pm 1.59$ | $0.76\pm 0.10$ | – | $0.00\pm 0.00$ |
| Qwen 3.6 Plus | $\underline{0.71\pm 0.10}$ | $0.79\pm 0.10$ | $0.71\pm 0.10$ | $6.57\pm 1.62$ | $0.76\pm 0.10$ | $\underline{0.75\pm 0.25}$ | $\mathbf{0.19\pm 0.09}$ |
| GPT 5.1 | $0.52\pm 0.11$ | $0.52\pm 0.11$ | $0.90\pm 0.07$ | $12.00\pm 2.30$ | $0.81\pm 0.09$ | $0.00\pm 0.00$ | $0.05\pm 0.05$ |
| Claude Sonnet 4.6 | $\mathbf{0.90\pm 0.07}$ | $\mathbf{0.90\pm 0.07}$ | $\underline{0.95\pm 0.05}$ | $\underline{21.67\pm 4.55}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.14\pm 0.08}$ |
| E2: Self-identification without mirror evidence |  |  |  |  |  |  |  |
| Ministral 3 14B | $0.00\pm 0.00$ | $0.00\pm 0.00$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.10\pm 0.07$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemma4 26B | $0.10\pm 0.07$ | $0.29\pm 0.18$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.10\pm 0.07$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemma4 31B | $0.05\pm 0.05$ | $0.25\pm 0.25$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.05\pm 0.05$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemini 2.5 Flash | $0.10\pm 0.07$ | $0.15\pm 0.10$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.14\pm 0.08$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemini 2.5 Pro | $\underline{0.38\pm 0.11}$ | $\underline{0.40\pm 0.11}$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $\underline{0.52\pm 0.11}$ | – | $\mathbf{0.00\pm 0.00}$ |
| Qwen 3.6 Plus | $0.14\pm 0.08$ | $0.33\pm 0.17$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.14\pm 0.08$ | – | $\mathbf{0.00\pm 0.00}$ |
| GPT 5.1 | $0.19\pm 0.09$ | $0.19\pm 0.09$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $0.00\pm 0.00$ | – | $\mathbf{0.00\pm 0.00}$ |
| Claude Sonnet 4.6 | $\mathbf{0.52\pm 0.11}$ | $\mathbf{0.52\pm 0.11}$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.00\pm 0.00}$ | $\mathbf{0.76\pm 0.10}$ | – | $\mathbf{0.00\pm 0.00}$ |
| E3: Self-identification under conflicting linguistic information |  |  |  |  |  |  |  |
| Ministral 3 14B | $0.24\pm 0.10$ | $\mathbf{0.83\pm 0.17}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{38.81\pm 3.06}$ | $0.76\pm 0.10$ | $0.67\pm 0.33$ | $0.14\pm 0.08$ |
| Gemma4 26B | $0.29\pm 0.10$ | $0.60\pm 0.16$ | $0.67\pm 0.11$ | $23.05\pm 4.49$ | $0.62\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $0.19\pm 0.09$ |
| Gemma4 31B | $0.33\pm 0.11$ | $0.78\pm 0.15$ | $0.57\pm 0.11$ | $9.67\pm 3.26$ | $0.33\pm 0.11$ | $0.67\pm 0.33$ | $0.14\pm 0.08$ |
| Gemini 2.5 Flash | $0.33\pm 0.11$ | $0.47\pm 0.13$ | $\mathbf{1.00\pm 0.00}$ | $\underline{38.24\pm 4.00}$ | $\mathbf{0.95\pm 0.05}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{0.52\pm 0.11}$ |
| Gemini 2.5 Pro | $0.38\pm 0.11$ | $0.62\pm 0.14$ | $\underline{0.95\pm 0.05}$ | $33.33\pm 5.95$ | $\underline{0.81\pm 0.09}$ | $\underline{0.80\pm 0.13}$ | $0.48\pm 0.11$ |
| Qwen 3.6 Plus | $\underline{0.43\pm 0.11}$ | $\underline{0.82\pm 0.12}$ | $0.86\pm 0.08$ | $32.76\pm 5.55$ | $0.71\pm 0.10$ | $\underline{0.80\pm 0.13}$ | $0.48\pm 0.11$ |
| GPT 5.1 | $\mathbf{0.52\pm 0.11}$ | $0.52\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $27.81\pm 4.02$ | $0.62\pm 0.11$ | $0.50\pm 0.15$ | $\mathbf{0.57\pm 0.11}$ |
| Claude Sonnet 4.6 | $0.14\pm 0.08$ | $0.15\pm 0.08$ | $\mathbf{1.00\pm 0.00}$ | $36.57\pm 4.36$ | $0.29\pm 0.10$ | $0.12\pm 0.12$ | $0.38\pm 0.11$ |
| E4: Self–other disambiguation under visual ambiguity |  |  |  |  |  |  |  |
| Ministral 3 14B | $0.33\pm 0.11$ | $\mathbf{0.88\pm 0.12}$ | $\mathbf{1.00\pm 0.00}$ | $\underline{24.81\pm 3.01}$ | $0.81\pm 0.09$ | $\mathbf{1.00\pm 0.00}$ | $0.24\pm 0.09$ |
| Gemma4 26B | $0.19\pm 0.09$ | $0.27\pm 0.12$ | $\underline{0.95\pm 0.05}$ | $20.81\pm 3.65$ | $0.62\pm 0.11$ | $0.67\pm 0.21$ | $0.29\pm 0.10$ |
| Gemma4 31B | $0.38\pm 0.11$ | $0.50\pm 0.13$ | $\mathbf{1.00\pm 0.00}$ | $9.86\pm 1.47$ | $0.48\pm 0.11$ | $0.00\pm 0.00$ | $0.14\pm 0.08$ |
| Gemini 2.5 Flash | $0.38\pm 0.11$ | $0.53\pm 0.13$ | $\underline{0.95\pm 0.05}$ | $21.57\pm 3.50$ | $0.86\pm 0.08$ | $0.71\pm 0.18$ | $0.33\pm 0.10$ |
| Gemini 2.5 Pro | $\mathbf{0.71\pm 0.10}$ | $0.71\pm 0.10$ | $\underline{0.95\pm 0.05}$ | $23.33\pm 3.70$ | $\underline{0.95\pm 0.05}$ | $\underline{0.88\pm 0.12}$ | $\underline{0.38\pm 0.11}$ |
| Qwen 3.6 Plus | $\underline{0.67\pm 0.11}$ | $\underline{0.78\pm 0.10}$ | $0.86\pm 0.08$ | $12.43\pm 2.46$ | $0.76\pm 0.10$ | $\underline{0.88\pm 0.12}$ | $\underline{0.38\pm 0.11}$ |
| GPT 5.1 | $0.38\pm 0.11$ | $0.38\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $19.29\pm 2.36$ | $0.76\pm 0.10$ | $0.80\pm 0.20$ | $0.24\pm 0.09$ |
| Claude Sonnet 4.6 | $\underline{0.67\pm 0.11}$ | $0.70\pm 0.11$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{39.14\pm 4.91}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{0.43\pm 0.11}$ |
| E5: Robust self-identification under occlusion |  |  |  |  |  |  |  |
| Ministral 3 14B | $0.00\pm 0.00$ | $0.00\pm 0.00$ | $\mathbf{1.00\pm 0.00}$ | $\mathbf{37.19\pm 3.25}$ | $\underline{0.05\pm 0.05}$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemma4 26B | $0.05\pm 0.05$ | $0.06\pm 0.06$ | $0.81\pm 0.09$ | $17.43\pm 4.19$ | $0.00\pm 0.00$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemma4 31B | $0.10\pm 0.07$ | $0.15\pm 0.10$ | $\mathbf{1.00\pm 0.00}$ | $22.62\pm 3.97$ | $0.00\pm 0.00$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemini 2.5 Flash | $0.19\pm 0.09$ | $0.19\pm 0.09$ | $\mathbf{1.00\pm 0.00}$ | $\underline{34.90\pm 2.83}$ | $\mathbf{0.19\pm 0.09}$ | – | $\mathbf{0.00\pm 0.00}$ |
| Gemini 2.5 Pro | $0.19\pm 0.09$ | $0.19\pm 0.09$ | $\mathbf{1.00\pm 0.00}$ | $17.86\pm 2.75$ | $\underline{0.05\pm 0.05}$ | – | $\mathbf{0.00\pm 0.00}$ |
| Qwen 3.6 Plus | $0.14\pm 0.08$ | $\underline{0.38\pm 0.18}$ | $\underline{0.95\pm 0.05}$ | $29.38\pm 5.15$ | $\underline{0.05\pm 0.05}$ | – | $\mathbf{0.00\pm 0.00}$ |
| GPT 5.1 | $\underline{0.24\pm 0.10}$ | $0.24\pm 0.10$ | $\underline{0.95\pm 0.05}$ | $27.38\pm 3.37$ | $0.00\pm 0.00$ | – | $\mathbf{0.00\pm 0.00}$ |
| Claude Sonnet 4.6 | $\mathbf{0.48\pm 0.11}$ | $\mathbf{0.48\pm 0.11}$ | $\mathbf{1.00\pm 0.00}$ | $31.48\pm 2.27$ | $0.00\pm 0.00$ | – | $\mathbf{0.00\pm 0.00}$ |

<sub>SC</sub>denotes the corresponding applicability rate.

### A.2 Additional Analysis

The main paper reports the complete quantitative results in
Table [1](#S4.T1). Here, we provide complementary visual analyses that
highlight cross-experiment structure, action–attribution dissociations, and
the distinct failure modes of $E_{5}$.

Figure [4](#A1.F4) provides a compact summary of all reported
results. It highlights both the strongest overall models and the changing
metric profiles across experimental conditions.

![Refer to caption](2605.08816v1/Heatmap_final.png)

Figure [5](#A1.F5) makes the action–attribution gap more
visible. In particular, several models in $E_{3}$ and $E_{4}$ achieve moderate or
high CAAL without matching TSA, indicating that correct self-attribution does
not reliably translate into correct final behavior.

Figure [6](#A1.F6) isolates the gap between overall task
success and completion-conditioned success. Large positive values indicate
models that are substantially more accurate when conditioning only on episodes
that terminate with done, and therefore suggest that a non-trivial
part of the observed failure arises from unstable completion or commitment
policy rather than uniformly incorrect task resolution.

![Refer to caption](2605.08816v1/Tsa_Complete-Tsa.png)

Figure [7](#A1.F7) clarifies why $E_{5}$ should be interpreted
separately from the cube-selection tasks. For most models, failure arises less
from confidently selecting the wrong self-attribute than from terminating
without a committed final identification.

![Refer to caption](2605.08816v1/images/e5_identification_FINALpdf.png)

### A.3 Qualitative Examples

Qualitative examples of successful and failed episodes of some of the evaluated models. All experiments were conducted in a custom-built 3D MuJoCo environment, using the standard “humanoid” robot settings for each spawned agent.

![Refer to caption](2605.08816v1/qualitative_all.png)

### A.4 Prompt Templates

All reported experiments were run with the same interaction protocol. At each step, the model received: (i) a system prompt, (ii) a user prompt containing the task instruction together with the recent step history and navigation context, and (iii) the current first-person RGB observation.

Two prompt families were used. $E_{1}$, $E_{2}$, $E_{3}$, and $E_{4}$ used a cube-selection prompt, while $E_{5}$ used an exploration prompt.

#### Shared dynamic context.

At each step, the user prompt also included: (i) the recent action–thought history, (ii) the current position and orientation, (iii) the remaining step budget, and (iv) a warning if the previous movement hit a wall.

#### Cube-selection prompt family ($E_{1}$, $E_{2}$, $E_{3}$, $E_{4}$).

System prompt used in $E_{1}$, $E_{2}$, and $E_{4}$:

```
You are a robot control agent.
Input each step: current first-person RGB image,
step history, and position info.
Return ONLY one valid JSON object with exactly these keys:
"view-description", "reasoning", "action",
"summary", "selected_cube", "identification".
Allowed actions:
  w = move forward
  s = move backward
  a = turn left by 30 degrees
  d = turn right by 30 degrees
  done = task complete
Rules:
  - action must be one of: w, a, s, d, done
  - do not use markdown fences
  - do not output any text outside the JSON object
  - selected_cube must be a valid color only when action is "done";
    otherwise selected_cube must be "none"
  - identification must always be present
Use action "done" only when you have enough evidence
to confidently select a cube.
If you are uncertain, keep exploring instead of using "done".
To select a cube you MUST be physically near it (at most 1 step away).
Do not invent visual evidence that is not present in the image or prompt.
```
User prompt:

Task: Identify your own body color using mirror evidence,
then select the physical
cube that matches that color.
<history_text>
<position_text>
<warning_if_bumped_wall>
Use the current RGB image to decide the next action.
Return one JSON object matching the required schema. If action is ’done’,
justify the selected cube with evidence.

For $E_{3}$, the system prompt was identical except that the first line became:

You are a <wrong_color> robot.

#### Exploration prompt family ($E_{5}$).

System prompt used in $E_{5}$:

You are a robot control agent navigating a mirrored room
with moving distractor robots.
Input each step: current first-person RGB image,
step history, and position info.
Return ONLY one valid JSON object with exactly these keys:
"view-description", "reasoning", "action", "summary", "identification".
Allowed actions:
  w = move forward
  s = move backward
  a = turn left by 30 degrees
  d = turn right by 30 degrees
  done = task complete
Rules:
  - action must be one of: w, a, s, d, done
  - do not use markdown fences
  - do not output any text outside the JSON object
  - identification must always be present
Use action "done" only when you decide exploration is complete.
Do not invent visual evidence that is not present in the image or prompt.

User prompt:

Task: Explore the room and observe distractor robots.
<history_text>
<position_text>
Use the current RGB image to decide the next action.
Return one JSON object matching the required schema.

### A.5 Evaluated Models

Table [3](#A1.T3) reports the evaluated models together with their
vendor, the backend used in the experiments, and the exact model identifier
used in the final runs.

| Paper name | Vendor | Backend | Exact model ID |
|---|---|---|---|
| Claude Sonnet 4.6 | Anthropic | OpenRouter | anthropic/claude-sonnet-4.6 |
| Gemini 2.5 Flash |  |  | gemini-2.5-flash |
| Gemini 2.5 Pro |  |  | gemini-2.5-pro |
| Gemma4 26B |  | OpenRouter | google/gemma-4-26b-a4b-it:nitro |
| Gemma4 31B |  | OpenRouter | google/gemma-4-31b-it:nitro |
| GPT-5.1 | OpenAI | OpenAI | gpt-5.1 |
| Ministral 3 14B | Mistral AI | OpenRouter | mistralai/ministral-14b-2512:nitro |
| Qwen 3.6 Plus | Qwen | OpenRouter | qwen/qwen3.6-plus |

### A.6 Metric Evaluation Details

All reported metrics are computed at the episode level and then aggregated by model and experiment. Let $\tau_{i}$ denote the first timestep at which episode $i$ terminates with action done, when such a timestep exists.

#### Per-episode metrics.

Task Success Accuracy (TSA) is defined differently across task families. In $E_{1}$–$E_{4}$, TSA is $1$ if the cube selected at $\tau_{i}$ matches the agent’s ground-truth body color, and $0$ otherwise. In $E_{5}$, TSA is $1$ if the final self-attribution at $\tau_{i}$ matches the agent’s ground-truth body color, and $0$ otherwise.

Time-to-Decision (TTD) is the timestep of the first done action. If an episode never terminates, TTD is set to the trajectory length. Mirror Consultation Rate (MCR) is $1$ if mirror evidence becomes visible at least once before $\tau_{i}$, and $0$ otherwise.

Mirror-Then-Action Temporal Ordering (MTATO) is defined only for successful episodes. It is $1$ if mirror evidence is first observed before $\tau_{i}$, and $0$ otherwise. Failed episodes therefore contribute undefined values rather than zeros.

Correct Attribution At Least Once (CAAL) is $1$ if, before $\tau_{i}$, the agent produces at least one self-attribution equal to its ground-truth body color, and $0$ otherwise.

Confabulation Rate (CR) measures whether the agent commits to a self-attribution before observing mirror evidence. Let $t_{i}^{\mathrm{claim}}$ denote the first timestep before $\tau_{i}$ at which the agent outputs a self-color different from unknown, and let $t_{i}^{\mathrm{mirror}}$ denote the first timestep before $\tau_{i}$ at which mirror evidence becomes visible, whenever these timesteps exist. We define

|  | $$ \mathrm{CR}_{i}=\begin{cases}1,&\text{if }t_{i}^{\mathrm{claim}}\text{ exists and either }t_{i}^{\mathrm{mirror}}\text{ does not exist}\\ &\text{or }t_{i}^{\mathrm{claim}}<t_{i}^{\mathrm{mirror}},\\ 0,&\text{otherwise.}\end{cases} $$ |  |

#### Undefined cases.

MTATO is undefined for unsuccessful episodes, since it is intended to measure whether mirror evidence preceded a correct final decision. In tables, undefined values are reported as --; in aggregation, they are excluded rather than treated as zeros.

#### Chance baselines.

For $E_{1}$–$E_{4}$, the chance baseline for TSA is $1/3$, since the final task decision is a choice among three candidate cubes. No directly comparable cube-selection chance baseline is defined for $E_{5}$, because its final task decision is an open-ended self-attribution rather than a cube choice. As reference points, a uniform random guess over the ten color labels would yield success probability $1/10$, while a uniform random choice over the ten colors plus unknown would yield $1/11\approx 0.091$. We therefore do not plot a single shared chance marker for $E_{5}$.

#### Aggregation.

For each model–experiment pair, we aggregate episode-level metric values across all evaluated runs. Reported means are arithmetic means over episodes, after excluding undefined values when applicable (e.g., MTATO). Standard errors are computed as the standard error of the mean over the same set of episodes. Thus, for each reported metric, the appendix tables summarize the distribution of episode-level scores for a fixed model in a fixed experiment.

### A.7 Evaluation Protocol and Run Counts

Table [4](#A1.T4) summarizes the evaluation protocol used in the
final benchmark, including the agent control loop, environment configuration,
and aggregate evaluation counts. All scenes are simulated in
MuJoCo [[31](#bib.bib1)].
.

| Panel A: Control loop and environment |  |
| Backend | MuJoCo [ [31](#bib.bib1) ] with first-person RGB observations |
| Rendering | 640$\times$480 resolution; vertical FOV 110 <sup>∘</sup> |
| Per-step input | RGB frame, task instruction, navigation state, and 1-step textual history |
| Per-step output | Structured JSON with action, self-attribution, and task-dependent decision field |
| Action space | w, a, s, d, done |
| Control and stopping | Discrete kinematic motion with 30 <sup>∘</sup> rotations; termination on done or after 100 steps |
| Decoding | Sampling temperature fixed at 0.2 across providers |
| Per-run randomization | $E_{1}$–$E_{3}$: ego color + 3 candidate cube colors/placements; $E_{4}$: 1–6 moving distractor agents with randomized colors and motion; $E_{5}$: 1–6 moving distractor agents plus clutter cubes with randomized placement |
| Panel B: Evaluation counts |  |
| Models and episodes | 8 models; 3 seeds/model-condition; 7 runs/seed; 21 episodes/model-condition |
| Benchmark size | 40 model-condition pairs; 840 total evaluation episodes |