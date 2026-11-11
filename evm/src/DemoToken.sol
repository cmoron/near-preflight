// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Demo ERC-20 token with a trap of your choice. Deployed only on a local copy
/// of Base (anvil): it shows what the sentinel detects, it trades nowhere.
contract DemoToken {
    enum Trap {
        None, // healthy witness
        OwnerReclaim, // the owner takes anyone's tokens back through transferFrom
        SellBlocked, // every sale to the pair reverts
        SellBlockedLater, // the sale works right after the buy, no longer after 10 minutes
        SellTax, // 90 % of each sale goes to the owner
        SellTaxLater, // untaxed sale right after the buy, taxed at 90 % after 10 minutes
        HoldOneBlock, // honest: no sale in the buy's block (anti-sandwich), free afterwards
        SimDetector, // the sale works only in simulation: zero gas price or base fee
        FrozenAddress, // tokens held by `special` can never leave it (e.g. the guard's public EVM address)
        SellTax20, // 20 % of each sale goes to the owner: a warn, not a block
        GasHungry // a sale reverts unless the transaction has 500,000 gas left (the guard signs 250,000)
    }

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    Trap public immutable trap;
    /// Address targeted by `FrozenAddress`, zero for the other traps.
    address public immutable special;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public boughtAt;
    mapping(address => uint256) public boughtBlock;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, Trap trap_, address special_) {
        name = name_;
        symbol = symbol_;
        trap = trap_;
        special = special_;
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address pair_) external {
        require(msg.sender == owner, "owner");
        pair = pair_;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (!(trap == Trap.OwnerReclaim && msg.sender == owner)) {
            uint256 allowed = allowance[from][msg.sender];
            require(allowed >= value, "allowance");
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        if (trap == Trap.FrozenAddress && from == special) revert("address frozen");
        uint256 fee;
        if (to == pair && from != owner) {
            if (trap == Trap.SellBlocked) revert("sale closed");
            if (trap == Trap.SellBlockedLater && block.timestamp > boughtAt[from] + 10 minutes) {
                revert("sale closed after 10 minutes");
            }
            if (trap == Trap.HoldOneBlock && block.number <= boughtBlock[from]) revert("hold one block");
            if (trap == Trap.SimDetector && tx.gasprice != 0 && block.basefee != 0) revert("real sale refused");
            if (trap == Trap.GasHungry && gasleft() < 500_000) revert("sale needs 500,000 gas");
            if (trap == Trap.SellTax) fee = (value * 90) / 100;
            if (trap == Trap.SellTax20) fee = (value * 20) / 100;
            if (trap == Trap.SellTaxLater && block.timestamp > boughtAt[from] + 10 minutes) {
                fee = (value * 90) / 100;
            }
        }
        if (from == pair) {
            boughtAt[to] = block.timestamp;
            boughtBlock[to] = block.number;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value - fee;
        emit Transfer(from, to, value - fee);
        if (fee > 0) {
            balanceOf[owner] += fee;
            emit Transfer(from, owner, fee);
        }
    }
}
