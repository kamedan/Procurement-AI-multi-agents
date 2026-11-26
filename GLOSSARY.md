# ProcureAI

ProcureAI is a multi-tenant procurement workspace that turns a purchasing need and supplier quotations into a traceable comparison, an authorized commercial decision, and an approved purchase order.

## Language

### Organization and authority

**Tenant**:
A customer organization whose procurement records, suppliers, documents, and approvals are strictly isolated from all other organizations.
_Avoid_: Account, workspace instance, org

**Legal Entity**:
A purchasing company belonging to a **Tenant** with a configured base currency and unique **Purchase Order** numbering sequence.
_Avoid_: Subsidiary, billing account

**Approver**:
A member of a **Tenant** explicitly assigned financial authority under an active approval policy to decide a **Supplier Award** or **PO Release**.
_Avoid_: Admin, reviewer, manager (unless explicitly assigned)

### Request and sourcing

**Purchase Request**:
A formal internal purchasing need owned by a **Tenant**, tracked across one or more immutable **Request Versions**.
_Avoid_: Requisition, order, ticket

**Request Version**:
An immutable snapshot of a **Purchase Request**'s line items, quantities, mandatory specifications, preferences, delivery deadline, and budget cap.
_Avoid_: Request edit, draft update

**Supplier**:
A vendor record stored in a **Tenant**'s directory with contacts, categories, and human-controlled verification status; presence in the directory does not imply verification or approval.
_Avoid_: Verified vendor, marketplace seller

**RFQ (Request for Quotation)**:
A versioned sourcing package prepared from a fixed **Request Version** for selected **Suppliers**, requesting itemized prices, freight, tax inclusion, delivery, warranty, and payment terms.
_Avoid_: Bid, tender, email blast

**Distribution Record**:
A human-recorded log that an exported **RFQ** was shared with specific **Suppliers** through external channels; distinct from merely exporting a document and distinct from supplier acknowledgement.
_Avoid_: Sent confirmation, delivered RFQ

### Quotations and comparison

**Quotation**:
A commercial offer returned by a **Supplier** in response to an **RFQ**, tracked across immutable **Quote Revisions**.
_Avoid_: Estimate, invoice, bid sheet

**Quote Revision**:
An immutable, confirmed snapshot of a **Quotation**'s line items, currency, cost components, validity date, and delivery terms; new offers or human corrections create a new revision rather than overwriting prior history.
_Avoid_: Updated quote, latest price

**Field Evidence**:
A source link connecting an extracted quotation value to its originating document, page, and excerpt.
_Avoid_: Citation score, AI confidence

**Field Correction**:
An attributable human edit to an extracted quotation field that records editor, timestamp, prior value, new value, and reason while preserving original **Field Evidence**.
_Avoid_: Override, manual overwrite

**Comparison**:
A deterministic evaluation of confirmed **Quote Revisions** against a fixed **Request Version** and policy, checking mandatory eligibility before sorting eligible offers by **Total Quoted Cost**.
_Avoid_: AI ranking, vendor score

**Total Quoted Cost**:
The deterministic sum of item subtotals minus explicit discounts plus quoted freight, quoted tax, and other included fees in one currency; missing components remain unknown rather than zero.
_Avoid_: Landed cost, payable total, savings basis

**Budget Headroom**:
The difference between a **Purchase Request**'s configured budget cap and an eligible offer's **Total Quoted Cost**; not a claim of realized procurement savings.
_Avoid_: Savings, cost reduction

### Decisions and purchase orders

**Approval Request**:
A version- and payload-hash-bound decision packet submitted for human review of either a **Supplier Award** or a **PO Release**.
_Avoid_: Notification, chat confirmation

**Approval Decision**:
An explicit, recorded human outcome (approve, reject, or request changes) made by an eligible **Approver** against a specific **Approval Request**.
_Avoid_: Auto-approval, agent sign-off

**Supplier Award**:
The authorized commercial selection of a winning eligible **Supplier** and **Quote Revision**; precedes and is distinct from **PO Release**.
_Avoid_: Placed order, PO approval

**PO Release**:
The separate final human authorization permitting a drafted **Purchase Order** to be assigned a final number and rendered as an approved artifact.
_Avoid_: Dispatch, payment approval

**Purchase Order (PO)**:
A numbered commercial order prepared from an approved **Supplier Award** and finalized upon **PO Release**, whose commercial terms are immutable once released.
_Avoid_: Invoice, receipt, contract

**Approved PO Ready for Issue**:
The terminal MVP state of a finalized **Purchase Order** whose approved PDF is available for export; does not mean the order was sent to, accepted by, delivered by, or paid to the **Supplier**.
_Avoid_: Issued PO, sent order, fulfilled order

**External Issue**:
A separate human-recorded event noting that an **Approved PO Ready for Issue** was transmitted to the **Supplier** outside ProcureAI, with supporting reference.
_Avoid_: Exported PDF, completed delivery
